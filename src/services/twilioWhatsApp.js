const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const fromNumber = process.env.TWILIO_WHATSAPP_FROM

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

/**
 * Sends one WhatsApp text message via Twilio Programmable Messaging.
 */
export async function sendTwilioWhatsAppMessage({ to, body }) {
  if (!isTwilioWhatsAppConfigured()) {
    throw new Error('Twilio WhatsApp is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM.')
  }

  const toAddress = normalizeWhatsAppAddress(to)
  const fromAddress = getTwilioWhatsAppFrom()
  if (!toAddress || !fromAddress) {
    throw new Error('Invalid WhatsApp addresses. Provide "to" and set TWILIO_WHATSAPP_FROM.')
  }
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('Message body is required.')
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  const form = new URLSearchParams({
    From: fromAddress,
    To: toAddress,
    Body: body.trim(),
  })

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

