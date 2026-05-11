import { Router } from 'express'
import mongoose from 'mongoose'
import { protectRoute } from '../middleware/auth.js'
import {
  getTwilioWhatsAppFrom,
  getWhatsAppSessionWindowMs,
  getTwilioWhatsAppCustomerTemplateSid,
  getTwilioWhatsAppDefaultTemplateSid,
  getTwilioWhatsAppUserLogTemplateSid,
  isWithinWhatsAppSessionWindow,
  isTwilioWhatsAppConfigured,
  normalizeWhatsAppAddress,
  sendTwilioWhatsAppMessage,
} from '../services/twilioWhatsApp.js'
import { isDbConnected } from '../config/db.js'
import { WhatsAppSession } from '../models/WhatsAppSession.js'
import { Activity } from '../models/Activity.js'
import { WhatsAppPendingDelivery } from '../models/WhatsAppPendingDelivery.js'
import {
  buildCustomerShareWhatsAppMessages,
  canUserViewActivityForWhatsApp,
} from '../services/customerShareWhatsAppMessages.js'

const router = Router()

async function flushPendingDeliveriesForAddress(address) {
  if (!address) return { flushed: 0, failed: 0 }
  const deliveries = await WhatsAppPendingDelivery.find({
    address,
    status: 'pending',
  })
    .sort({ createdAt: 1 })
    .limit(20)

  let flushed = 0
  let failed = 0
  for (const item of deliveries) {
    try {
      const messages = Array.isArray(item.messages) ? item.messages.filter((m) => typeof m === 'string' && m.trim()) : []
      for (const msg of messages) {
        await sendTwilioWhatsAppMessage({ to: address, body: msg.trim() })
      }
      item.status = 'sent'
      item.sentAt = new Date()
      item.lastError = ''
      await item.save()
      flushed += 1
    } catch (err) {
      item.status = 'failed'
      item.lastError = err?.message || String(err)
      await item.save()
      failed += 1
      console.warn('[twilio][whatsapp][pending-delivery][failed]', {
        address,
        deliveryId: String(item._id),
        error: item.lastError,
      })
    }
  }
  return { flushed, failed }
}

router.get('/debug', protectRoute, async (req, res, next) => {
  try {
    const rawTo = typeof req.query?.to === 'string' ? req.query.to.trim() : ''
    const normalizedTo = rawTo ? normalizeWhatsAppAddress(rawTo) : ''
    const sessionStateKnown = isDbConnected()
    let lastInboundAt = null
    let sessionOpen = false
    if (normalizedTo && sessionStateKnown) {
      const session = await WhatsAppSession.findOne({ address: normalizedTo }).lean()
      if (session?.lastInboundAt) {
        const dt = new Date(session.lastInboundAt)
        if (!Number.isNaN(dt.getTime())) {
          lastInboundAt = dt
          sessionOpen = isWithinWhatsAppSessionWindow(dt)
        }
      }
    }

    const templateSid = getTwilioWhatsAppDefaultTemplateSid()
    res.json({
      configured: isTwilioWhatsAppConfigured(),
      dbConnected: sessionStateKnown,
      from: getTwilioWhatsAppFrom(),
      hasDefaultTemplateSid: Boolean(templateSid),
      defaultTemplateSidPreview: templateSid ? `${templateSid.slice(0, 6)}...${templateSid.slice(-4)}` : '',
      sessionWindowMs: getWhatsAppSessionWindowMs(),
      recipient: normalizedTo
        ? {
            requestedTo: rawTo,
            normalizedTo,
            lastInboundAt,
            sessionOpen,
            canSendFreeformNow: sessionStateKnown ? sessionOpen : true,
            note: sessionStateKnown
              ? sessionOpen
                ? '24h session is open for this recipient.'
                : '24h session is closed for this recipient. Free-form message will fail unless recipient replies first.'
              : 'Session state unknown because DB is not connected; backend cannot enforce 24h check.',
          }
        : {
            note: 'Pass query ?to=+<countrycode><number> to debug recipient session state.',
          },
      pendingDeliveries:
        normalizedTo && sessionStateKnown
          ? await WhatsAppPendingDelivery.find({ address: normalizedTo, status: 'pending' })
              .select({ _id: 1, activityId: 1, createdAt: 1, status: 1 })
              .sort({ createdAt: 1 })
              .limit(20)
              .lean()
          : [],
    })
  } catch (err) {
    next(err)
  }
})

router.get('/config', protectRoute, (_req, res) => {
  res.json({
    configured: isTwilioWhatsAppConfigured(),
    defaultTemplateSid: getTwilioWhatsAppDefaultTemplateSid(),
    customerTemplateSid: getTwilioWhatsAppCustomerTemplateSid(),
    userLogTemplateSid: getTwilioWhatsAppUserLogTemplateSid(),
  })
})

// Twilio webhook endpoint (Sandbox / production sender inbound messages).
// Configure in Twilio: "When a message comes in" -> POST https://<api>/api/whatsapp/webhook
router.post('/webhook', async (req, res) => {
  const from = typeof req.body?.From === 'string' ? req.body.From.trim() : ''
  const body = typeof req.body?.Body === 'string' ? req.body.Body.trim() : ''
  const normalizedFrom = normalizeWhatsAppAddress(from)

  console.log('[twilio][whatsapp][inbound]', {
    from: normalizedFrom || from,
    bodyPreview: body.slice(0, 200),
    messageSid: req.body?.MessageSid || '',
  })

  if (normalizedFrom && isDbConnected()) {
    try {
      await WhatsAppSession.findOneAndUpdate(
        { address: normalizedFrom },
        {
          $set: {
            address: normalizedFrom,
            lastInboundAt: new Date(),
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      )
      const pendingResult = await flushPendingDeliveriesForAddress(normalizedFrom)
      if (pendingResult.flushed > 0 || pendingResult.failed > 0) {
        console.log('[twilio][whatsapp][pending-delivery][flush]', {
          address: normalizedFrom,
          flushed: pendingResult.flushed,
          failed: pendingResult.failed,
        })
      }
    } catch (err) {
      console.warn('[twilio][whatsapp][session][webhook-update-failed]', err?.message || err)
    }
  }

  // Twilio expects XML (TwiML) response; empty response is valid.
  res.type('text/xml').send('<Response></Response>')
})

// Internal API used by frontend button to send a WhatsApp update manually.
router.post('/send', protectRoute, async (req, res, next) => {
  try {
    if (!isTwilioWhatsAppConfigured()) {
      return res.status(503).json({
        error: 'Twilio WhatsApp is not configured on the server',
      })
    }

    const { to, message, contentSid, contentVariables, pendingActivityId } = req.body || {}
    if (!to || typeof to !== 'string') {
      return res.status(400).json({ error: 'Recipient phone number is required in "to"' })
    }
    const normalizedTo = normalizeWhatsAppAddress(to)
    if (!normalizedTo) {
      return res.status(400).json({ error: 'Recipient phone number format is invalid in "to"' })
    }
    const messageText = typeof message === 'string' ? message.trim() : ''
    const requestedTemplateSid = typeof contentSid === 'string' ? contentSid.trim() : ''
    const hasMessage = Boolean(messageText)
    const hasTemplate = Boolean(requestedTemplateSid)
    if (!hasMessage && !hasTemplate) {
      return res.status(400).json({ error: 'Provide either "message" or "contentSid".' })
    }
    if (hasMessage && hasTemplate) {
      return res.status(400).json({ error: 'Provide either "message" or template fields, not both.' })
    }

    const sessionStateKnown = isDbConnected()
    let sessionOpen = false
    let lastInboundAt = null
    if (sessionStateKnown) {
      const session = await WhatsAppSession.findOne({ address: normalizedTo })
      if (session?.lastInboundAt instanceof Date) {
        lastInboundAt = session.lastInboundAt
        sessionOpen = isWithinWhatsAppSessionWindow(session.lastInboundAt)
      }
    }

    let sendBody = hasMessage ? messageText : undefined
    let sendTemplateSid = hasTemplate ? requestedTemplateSid : undefined
    let sendTemplateVariables = hasTemplate && typeof contentVariables === 'string' ? contentVariables : undefined

    if (hasMessage && sessionStateKnown && !sessionOpen) {
      return res.status(409).json({
        error: 'Cannot send free-form message because WhatsApp 24h session is closed. Ask user to reply first or send an approved template explicitly with contentSid.',
        sessionOpen: false,
        requiresTemplate: true,
        sessionWindowMs: getWhatsAppSessionWindowMs(),
        lastInboundAt,
      })
    }

    const sent = await sendTwilioWhatsAppMessage({
      to: normalizedTo,
      body: sendBody,
      contentSid: sendTemplateSid,
      contentVariables: sendTemplateVariables,
    })

    let pendingLogQueued = false
    const rawPendingId = typeof pendingActivityId === 'string' ? pendingActivityId.trim() : ''
    if (sendTemplateSid && rawPendingId && isDbConnected()) {
      if (!mongoose.Types.ObjectId.isValid(rawPendingId)) {
        console.warn('[twilio][whatsapp][pending-log][invalid-activity-id]', { pendingActivityId: rawPendingId })
      } else {
        try {
          const activity = await Activity.findById(rawPendingId).lean()
          if (!activity || activity.isArchived) {
            console.warn('[twilio][whatsapp][pending-log][activity-not-found]', { pendingActivityId: rawPendingId })
          } else if (!canUserViewActivityForWhatsApp(activity, req.user)) {
            console.warn('[twilio][whatsapp][pending-log][forbidden]', {
              pendingActivityId: rawPendingId,
              userId: String(req.user?._id || ''),
            })
          } else {
            const messages = buildCustomerShareWhatsAppMessages(activity)
            if (messages.length > 0) {
              await WhatsAppPendingDelivery.create({
                address: normalizedTo,
                activityId: activity._id,
                messages,
                status: 'pending',
              })
              pendingLogQueued = true
            }
          }
        } catch (err) {
          console.warn('[twilio][whatsapp][pending-log][queue-failed]', err?.message || err)
        }
      }
    }

    res.json({
      success: true,
      messageSid: sent.sid,
      status: sent.status,
      to: sent.to,
      from: sent.from,
      sessionOpen,
      usedTemplate: Boolean(sendTemplateSid),
      templateSidUsed: sendTemplateSid || null,
      sessionStateKnown,
      sessionWindowMs: getWhatsAppSessionWindowMs(),
      lastInboundAt,
      pendingLogQueued,
    })
  } catch (err) {
    next(err)
  }
})

export { router as whatsappRouter }

