import { Router } from 'express'
import { protectRoute } from '../middleware/auth.js'
import {
  getTwilioWhatsAppDefaultTemplateSid,
  isTwilioWhatsAppConfigured,
  sendTwilioWhatsAppMessage,
} from '../services/twilioWhatsApp.js'

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

  // Keep this minimal for now; app can later persist inbound threads if needed.
  console.log('[twilio][whatsapp][inbound]', {
    from,
    bodyPreview: body.slice(0, 200),
    messageSid: req.body?.MessageSid || '',
  })

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
    const messageText = typeof message === 'string' ? message.trim() : ''
    const templateSid = typeof contentSid === 'string' ? contentSid.trim() : ''
    const hasMessage = Boolean(messageText)
    const hasTemplate = Boolean(templateSid)
    if (!hasMessage && !hasTemplate) {
      return res.status(400).json({ error: 'Provide either "message" or "contentSid".' })
    }
    if (hasMessage && hasTemplate) {
      return res.status(400).json({ error: 'Provide either "message" or template fields, not both.' })
    }

    const sent = await sendTwilioWhatsAppMessage({
      to,
      body: hasMessage ? messageText : undefined,
      contentSid: hasTemplate ? templateSid : undefined,
      contentVariables: hasTemplate && typeof contentVariables === 'string' ? contentVariables : undefined,
    })

    res.json({
      success: true,
      messageSid: sent.sid,
      status: sent.status,
      to: sent.to,
      from: sent.from,
    })
  } catch (err) {
    next(err)
  }
})

export { router as whatsappRouter }

