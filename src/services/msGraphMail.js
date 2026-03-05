/**
 * Microsoft 365 mail helper (Phase 7 foundation).
 *
 * Uses client credentials (app registration) to call Microsoft Graph
 * and send mail from a configured mailbox.
 *
 * Required env:
 * - AZURE_CLIENT_ID
 * - AZURE_CLIENT_SECRET
 * - AZURE_TENANT_ID
 * - MS365_SENDER (mailbox address, e.g. reports@apexquality.net)
 */
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

/**
 * Send an email via Microsoft Graph as the configured sender mailbox.
 *
 * @param {{ to: string | string[]; subject: string; html?: string; text?: string }} params
 */
async function sendMs365Mail({ to, subject, html, text }) {
  if (!isMsGraphConfigured()) {
    throw new Error('Microsoft 365 mail is not configured. Set AZURE_* and MS365_SENDER env vars.')
  }

  const recipients = (Array.isArray(to) ? to : [to]).map((address) => ({
    emailAddress: { address },
  }))

  const bodyContent =
    html != null
      ? { contentType: 'HTML', content: html }
      : { contentType: 'Text', content: text ?? '' }

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

export { isMsGraphConfigured, sendMs365Mail }

