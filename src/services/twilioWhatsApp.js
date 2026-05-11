const accountSid = process.env.TWILIO_ACCOUNT_SID
const authToken = process.env.TWILIO_AUTH_TOKEN
const fromNumber = process.env.TWILIO_WHATSAPP_FROM
const defaultTemplateSid = process.env.TWILIO_WHATSAPP_TEMPLATE_SID
const customerTemplateSid = process.env.TWILIO_WHATSAPP_CUSTOMER_TEMPLATE_SID
const userLogTemplateSid = process.env.TWILIO_WHATSAPP_USER_LOG_TEMPLATE_SID
const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

export function normalizeWhatsAppAddress(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.toLowerCase().startsWith('whatsapp:') ? trimmed : `whatsapp:${trimmed}`
}

export function getWhatsAppSessionWindowMs() {
  return WHATSAPP_SESSION_WINDOW_MS
}

export function isWithinWhatsAppSessionWindow(lastInboundAt, nowMs = Date.now()) {
  if (!(lastInboundAt instanceof Date) || Number.isNaN(lastInboundAt.getTime())) return false
  return nowMs - lastInboundAt.getTime() <= WHATSAPP_SESSION_WINDOW_MS
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

/** Business-initiated template for customer (Chat “Send WhatsApp” when session closed). */
export function getTwilioWhatsAppCustomerTemplateSid() {
  const c = typeof customerTemplateSid === 'string' ? customerTemplateSid.trim() : ''
  return c || getTwilioWhatsAppDefaultTemplateSid()
}

/** Template for internal user alerts when session closed (e.g. severity WhatsApp notify). */
export function getTwilioWhatsAppUserLogTemplateSid() {
  const u = typeof userLogTemplateSid === 'string' ? userLogTemplateSid.trim() : ''
  return u || getTwilioWhatsAppDefaultTemplateSid()
}

/**
 * Twilio/WhatsApp often rejects template variables with certain Unicode (e.g. em dash),
 * newlines, or invalid JSON. Returns a compact JSON string safe to send as ContentVariables.
 */
export function normalizeTwilioWhatsAppContentVariables(raw) {
  if (raw == null) return ''
  let parsed
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return ''
    try {
      parsed = JSON.parse(s)
    } catch {
      return ''
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw
  } else {
    return ''
  }
  const out = {}
  for (const [k, v] of Object.entries(parsed)) {
    const key = String(k).trim()
    if (!key) continue
    let val =
      v === null || v === undefined
        ? ''
        : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : JSON.stringify(v)
    val = val
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-') // fancy dashes → ASCII
      .replace(/\u00A0/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!val) val = 'N/A'
    if (val.length > 1020) val = val.slice(0, 1020)
    out[key] = val
  }
  if (Object.keys(out).length === 0) return ''
  return JSON.stringify(out)
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
    const normalizedVars = normalizeTwilioWhatsAppContentVariables(contentVariables)
    if (normalizedVars) {
      form.set('ContentVariables', normalizedVars)
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

