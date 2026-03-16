const tenantId = process.env.AZURE_TENANT_ID
const clientId = process.env.AZURE_CLIENT_ID
const clientSecret = process.env.AZURE_CLIENT_SECRET
const senderAddress = process.env.MS365_SENDER

function isMsGraphConfigured() {
  return Boolean(tenantId && clientId && clientSecret && senderAddress)
}

async function getAppAccessToken() {
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Microsoft 365 is not configured: set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET')
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get Microsoft Graph token: ${res.status} ${text}`)
  }

  const data = await res.json()
  return data.access_token
}

function normalizeEmailList(value) {
  if (!value) return []
  const arr = Array.isArray(value) ? value : [value]
  return arr
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
}

function toRecipients(addresses) {
  return normalizeEmailList(addresses).map((address) => ({
    emailAddress: { address },
  }))
}

function buildBody({ html, text }) {
  return html != null
    ? { contentType: 'HTML', content: html }
    : { contentType: 'Text', content: text ?? '' }
}

async function sendMs365Mail({ to, subject, html, text }) {
  if (!isMsGraphConfigured()) {
    throw new Error('Microsoft 365 mail is not configured. Set AZURE_* and MS365_SENDER env vars.')
  }

  const recipients = toRecipients(to)
  const bodyContent = buildBody({ html, text })

  const token = await getAppAccessToken()

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderAddress)}/sendMail`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: bodyContent,
        toRecipients: recipients,
      },
      saveToSentItems: true,
    }),
  })

  if (!res.ok) {
    const textBody = await res.text()
    throw new Error(`Failed to send Microsoft 365 mail: ${res.status} ${textBody}`)
  }
}

async function createMs365Draft({ to, cc, subject, html, text, attachments }) {
  if (!isMsGraphConfigured()) {
    throw new Error('Microsoft 365 mail is not configured. Set AZURE_* and MS365_SENDER env vars.')
  }

  const token = await getAppAccessToken()

  const draftRes = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderAddress)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject,
      body: buildBody({ html, text }),
      toRecipients: toRecipients(to),
      ccRecipients: toRecipients(cc),
    }),
  })

  if (!draftRes.ok) {
    const textBody = await draftRes.text()
    throw new Error(`Failed to create Microsoft 365 draft: ${draftRes.status} ${textBody}`)
  }

  const draft = await draftRes.json()

  const safeAttachments = Array.isArray(attachments) ? attachments : []
  for (const a of safeAttachments) {
    if (!a || typeof a !== 'object') continue
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : null
    const contentText = typeof a.contentText === 'string' ? a.contentText : null
    if (!name || contentText == null) continue

    const contentBytes = Buffer.from(contentText, 'utf8').toString('base64')
    const attRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderAddress)}/messages/${encodeURIComponent(
        draft.id
      )}/attachments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name,
          contentType: typeof a.contentType === 'string' && a.contentType ? a.contentType : 'text/plain',
          contentBytes,
        }),
      }
    )

    if (!attRes.ok) {
      const textBody = await attRes.text()
      throw new Error(`Failed to attach file to draft: ${attRes.status} ${textBody}`)
    }
  }

  return {
    id: draft.id,
    webLink: draft.webLink,
    createdDateTime: draft.createdDateTime,
    subject: draft.subject,
  }
}

async function sendMs365Draft({ messageId }) {
  if (!isMsGraphConfigured()) {
    throw new Error('Microsoft 365 mail is not configured. Set AZURE_* and MS365_SENDER env vars.')
  }
  if (!messageId || typeof messageId !== 'string') {
    throw new Error('messageId is required')
  }

  const token = await getAppAccessToken()
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderAddress)}/messages/${encodeURIComponent(messageId)}/send`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const textBody = await res.text()
    throw new Error(`Failed to send Microsoft 365 draft: ${res.status} ${textBody}`)
  }
}

export { isMsGraphConfigured, sendMs365Mail, createMs365Draft, sendMs365Draft }

