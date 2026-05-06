const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const fromNumber = process.env.TWILIO_WHATSAPP_FROM
const defaultTemplateSid = process.env.TWILIO_WHATSAPP_TEMPLATE_SID

function normalizeWhatsAppAddress(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.toLowerCase().startsWith('whatsapp:') ? trimmed : `whatsapp:${trimmed}`
}

export function isTwilioWhatsAppConfigured() {
  return Boolean(accountSid && authToken && fromNumber)
}

export function getTwilioWhatsAppFrom() {
  return normalizeWhatsAppAddress(fromNumber || '')
}

export function getTwilioWhatsAppDefaultTemplateSid() {
  return typeof defaultTemplateSid === 'string' ? defaultTemplateSid.trim() : ''
}

/**
 * Sends one WhatsApp message via Twilio Programmable Messaging.
 * Supports either freeform body (inside 24h window) or approved template.
 */
export async function sendTwilioWhatsAppMessage({ to, body, contentSid, contentVariables }) {
  if (!isTwilioWhatsAppConfigured()) {
    throw new Error('Twilio WhatsApp is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM.')
  }

  const toAddress = normalizeWhatsAppAddress(to)
  const fromAddress = getTwilioWhatsAppFrom()
  if (!toAddress || !fromAddress) {
    throw new Error('Invalid WhatsApp addresses. Provide "to" and set TWILIO_WHATSAPP_FROM.')
  }
  const bodyText = typeof body === 'string' ? body.trim() : ''
  const templateSid = typeof contentSid === 'string' ? contentSid.trim() : ''
  const hasBody = Boolean(bodyText)
  const hasTemplate = Boolean(templateSid)
  if (!hasBody && !hasTemplate) {
    throw new Error('Provide either message body or contentSid for template send.')
  }
  if (hasBody && hasTemplate) {
    throw new Error('Provide either message body or template fields, not both.')
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  const form = new URLSearchParams({
    From: fromAddress,
    To: toAddress,
  })
  if (hasBody) {
    form.set('Body', bodyText)
  } else {
    form.set('ContentSid', templateSid)
    if (typeof contentVariables === 'string' && contentVariables.trim()) {
      form.set('ContentVariables', contentVariables.trim())
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg =
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error_message === 'string' && data.error_message) ||
      `Twilio send failed (${res.status})`
    throw new Error(msg)
  }

  return {
    sid: data.sid,
    status: data.status,
    to: data.to,
    from: data.from,
  }
}

