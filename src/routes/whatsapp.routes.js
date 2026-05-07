import { Router } from 'express'
import { protectRoute } from '../middleware/auth.js'
import {
  getWhatsAppSessionWindowMs,
  getTwilioWhatsAppDefaultTemplateSid,
  isWithinWhatsAppSessionWindow,
  isTwilioWhatsAppConfigured,
  normalizeWhatsAppAddress,
  sendTwilioWhatsAppMessage,
} from '../services/twilioWhatsApp.js'
import { isDbConnected } from '../config/db.js'
import { WhatsAppSession } from '../models/WhatsAppSession.js'

const router = Router()

router.get('/config', protectRoute, (_req, res) => {
  res.json({
    configured: isTwilioWhatsAppConfigured(),
    defaultTemplateSid: getTwilioWhatsAppDefaultTemplateSid(),
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

    const { to, message, contentSid, contentVariables } = req.body || {}
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
    })
  } catch (err) {
    next(err)
  }
})

export { router as whatsappRouter }

