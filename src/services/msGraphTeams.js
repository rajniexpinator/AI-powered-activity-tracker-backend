import { getAppAccessToken, isMsGraphConfigured } from './msGraphMail.js'

/** Real licensed M365 user with Teams — not a shared mailbox (info@ often fails). Falls back to MS365_SENDER. */
const teamsSenderAddress = (process.env.MS365_TEAMS_SENDER || process.env.MS365_SENDER || '').trim()
const chatIdByRecipientUserId = new Map()

const TEAMS_APP_ACCESS_POLICY_HELP =
  'Azure API permissions look correct but Teams still blocked. A Teams admin must run PowerShell: ' +
  'Connect-MicrosoftTeams; New-CsApplicationAccessPolicy -Identity "ActivityTracker-Teams" -AppIds "YOUR_AZURE_CLIENT_ID"; ' +
  'Grant-CsApplicationAccessPolicy -PolicyName "ActivityTracker-Teams" -Global ' +
  '(or grant to saini@ and test@ individually). Wait 15–30 minutes, then retry.'

function isTeamsChatConfigured() {
  return isMsGraphConfigured()
}

function teams403Message(graphPath, method = 'GET', rawText = '') {
  let graphCode = ''
  let graphMessage = ''
  try {
    const parsed = JSON.parse(rawText)
    graphCode = parsed?.error?.code || ''
    graphMessage = parsed?.error?.message || ''
  } catch {
    /* ignore */
  }
  const graphDetail =
    graphCode || graphMessage ? ` Graph says: ${[graphCode, graphMessage].filter(Boolean).join(' — ')}.` : ''
  return (
    `Microsoft Teams blocked this request (${method} ${graphPath}).${graphDetail} ` +
    'Confirm Application permissions User.Read.All, Chat.Create, and Chat.ReadWrite.All are granted in Azure. ' +
    TEAMS_APP_ACCESS_POLICY_HELP
  )
}

async function graphJson(path, { method = 'GET', body } = {}) {
  const token = await getAppAccessToken()
  const url = path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 403) {
      throw new Error(teams403Message(path, method, text))
    }
    if (res.status === 404) {
      let email = ''
      try {
        const parsed = JSON.parse(text)
        const match = String(parsed?.error?.message || '').match(/Resource '([^']+)'/)
        if (match) email = match[1]
      } catch {
        /* ignore */
      }
      throw new Error(
        email
          ? `No Microsoft 365 user found for ${email} in your tenant. Teams alerts must go to a work email that exists in the same M365 tenant as your Azure app (e.g. apexquality.net), not a personal or external address.`
          : 'Microsoft 365 user not found in your tenant. Use a work email that exists in the same M365 organization as MS365_SENDER.'
      )
    }
    throw new Error(`Microsoft Graph Teams error ${res.status}: ${text}`)
  }
  if (res.status === 204) return null
  return res.json()
}

async function graphJsonAllowNotFound(path) {
  const token = await getAppAccessToken()
  const url = path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 403) {
      throw new Error(teams403Message(path, 'GET', text))
    }
    throw new Error(`Microsoft Graph Teams error ${res.status}: ${text}`)
  }
  return res.json()
}

async function getUserIdByEmail(email, { role = 'user' } = {}) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!normalized) throw new Error('Email is required for Teams chat')

  const direct = await graphJsonAllowNotFound(
    `/users/${encodeURIComponent(normalized)}?$select=id,mail,userPrincipalName`
  )
  if (direct?.id) return direct.id

  const escaped = normalized.replace(/'/g, "''")
  const filter = `mail eq '${escaped}' or userPrincipalName eq '${escaped}'`
  const listed = await graphJson(`/users?$filter=${encodeURIComponent(filter)}&$select=id,mail,userPrincipalName&$top=1`)
  const match = Array.isArray(listed?.value) ? listed.value[0] : null
  if (match?.id) return match.id

  if (role === 'sender') {
    throw new Error(
      `No Microsoft 365 user found for ${normalized} (MS365_TEAMS_SENDER / MS365_SENDER). ` +
        'Teams chat requires a real licensed user with Teams — shared mailboxes like info@ usually do not work. ' +
        'Set MS365_TEAMS_SENDER in .env to a person\'s work email (e.g. saini@apexquality.net).'
    )
  }
  throw new Error(
    `No Microsoft 365 user found for ${normalized}. ` +
      'The recipient must be a licensed user in your tenant with Teams (check Entra ID → Users).'
  )
}

async function findExistingOneOnOneChat(senderId, recipientId) {
  const data = await graphJson(`/users/${encodeURIComponent(senderId)}/chats?$expand=members`)
  for (const chat of data?.value || []) {
    if (chat?.chatType !== 'oneOnOne') continue
    const memberIds = (chat.members || [])
      .map((member) => member?.userId)
      .filter((id) => typeof id === 'string' && id.trim())
    if (memberIds.includes(recipientId)) return chat.id
  }
  return null
}

async function getOrCreateOneOnOneChat(senderId, recipientId) {
  const cached = chatIdByRecipientUserId.get(recipientId)
  if (cached) return cached

  try {
    const chat = await graphJson('/chats', {
      method: 'POST',
      body: {
        chatType: 'oneOnOne',
        members: [
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${senderId}')`,
          },
          {
            '@odata.type': '#microsoft.graph.aadUserConversationMember',
            roles: ['owner'],
            'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${recipientId}')`,
          },
        ],
      },
    })
    if (chat?.id) {
      chatIdByRecipientUserId.set(recipientId, chat.id)
      return chat.id
    }
  } catch (createErr) {
    const msg = createErr?.message || ''
    if (!/403|409|Conflict|already exists/i.test(msg)) {
      throw createErr
    }
  }

  const chatId = await findExistingOneOnOneChat(senderId, recipientId)
  if (!chatId) throw new Error('Failed to resolve Teams chat for recipient')
  chatIdByRecipientUserId.set(recipientId, chatId)
  return chatId
}

async function sendTeamsChatMessage(chatId, content) {
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text) return
  await graphJson(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: {
      body: {
        contentType: 'text',
        content: text,
      },
    },
  })
}

/**
 * Step-by-step Teams connectivity check (for debugging 403 after Azure consent).
 */
async function diagnoseTeamsSetup(recipientEmail) {
  const steps = []
  const azureClientId = process.env.AZURE_CLIENT_ID || ''
  const sender = teamsSenderAddress

  steps.push({
    step: 'config',
    ok: isTeamsChatConfigured(),
    detail: isTeamsChatConfigured()
      ? `Sender: ${sender || '(missing)'}`
      : 'Set AZURE_* and MS365_TEAMS_SENDER in .env',
  })
  if (!isTeamsChatConfigured() || !sender) {
    return { steps, azureClientId, policyHelp: TEAMS_APP_ACCESS_POLICY_HELP }
  }

  try {
    await getAppAccessToken()
    steps.push({ step: 'graph_token', ok: true, detail: 'Acquired Graph access token' })
  } catch (err) {
    steps.push({ step: 'graph_token', ok: false, detail: err?.message || String(err) })
    return { steps, azureClientId, policyHelp: TEAMS_APP_ACCESS_POLICY_HELP }
  }

  let senderId
  let recipientId
  try {
    senderId = await getUserIdByEmail(sender, { role: 'sender' })
    steps.push({ step: 'lookup_sender', ok: true, detail: `${sender} → user id found` })
  } catch (err) {
    steps.push({ step: 'lookup_sender', ok: false, detail: err?.message || String(err) })
    return { steps, azureClientId, policyHelp: TEAMS_APP_ACCESS_POLICY_HELP }
  }

  const normalizedRecipient = typeof recipientEmail === 'string' ? recipientEmail.trim().toLowerCase() : ''
  if (normalizedRecipient) {
    try {
      recipientId = await getUserIdByEmail(normalizedRecipient, { role: 'recipient' })
      steps.push({ step: 'lookup_recipient', ok: true, detail: `${normalizedRecipient} → user id found` })
    } catch (err) {
      steps.push({ step: 'lookup_recipient', ok: false, detail: err?.message || String(err) })
      return { steps, azureClientId, policyHelp: TEAMS_APP_ACCESS_POLICY_HELP }
    }
  }

  if (senderId && recipientId && senderId !== recipientId) {
    let chatId = null
    try {
      const chat = await graphJson('/chats', {
        method: 'POST',
        body: {
          chatType: 'oneOnOne',
          members: [
            {
              '@odata.type': '#microsoft.graph.aadUserConversationMember',
              roles: ['owner'],
              'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${senderId}')`,
            },
            {
              '@odata.type': '#microsoft.graph.aadUserConversationMember',
              roles: ['owner'],
              'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${recipientId}')`,
            },
          ],
        },
      })
      chatId = chat?.id
      steps.push({ step: 'create_chat', ok: true, detail: 'POST /chats succeeded' })
    } catch (err) {
      steps.push({
        step: 'create_chat',
        ok: false,
        detail: err?.message || String(err),
        likelyFix: 'Teams Application Access Policy or Azure Chat.Create permission',
      })
      return { steps, azureClientId, policyHelp: TEAMS_APP_ACCESS_POLICY_HELP }
    }

    if (chatId) {
      try {
        await graphJson(`/chats/${encodeURIComponent(chatId)}/messages`, {
          method: 'POST',
          body: {
            body: {
              contentType: 'text',
              content: 'Activity Tracker connectivity test (safe to ignore).',
            },
          },
        })
        steps.push({ step: 'send_message', ok: true, detail: 'POST /chats/{id}/messages succeeded' })
      } catch (err) {
        const detail = err?.message || String(err)
        const migrateOnly = /Teamwork\.Migrate\.All/i.test(detail)
        steps.push({
          step: 'send_message',
          ok: false,
          detail,
          likelyFix: migrateOnly
            ? 'Microsoft Graph only allows app-only chat messages with Teamwork.Migrate.All (migration mode), not normal alerts. Use Teams Activity Feed API, a Teams bot, or email notifications instead.'
            : 'Check Chat.ReadWrite.All and Teams Application Access Policy',
        })
      }
    }
  }

  return { steps, azureClientId, policyHelp: TEAMS_APP_ACCESS_POLICY_HELP }
}

async function sendTeamsChatMessages({ recipientEmail, messages }) {
  if (!isTeamsChatConfigured()) {
    throw new Error('Microsoft 365 Teams chat is not configured. Set AZURE_* and MS365_SENDER env vars.')
  }
  if (!teamsSenderAddress) {
    throw new Error('MS365_TEAMS_SENDER or MS365_SENDER is required for Teams chat notifications')
  }

  const chunks = (Array.isArray(messages) ? messages : [messages])
    .filter((msg) => typeof msg === 'string' && msg.trim())
    .map((msg) => msg.trim())
  if (chunks.length === 0) return

  const senderId = await getUserIdByEmail(teamsSenderAddress, { role: 'sender' })
  const recipientId = await getUserIdByEmail(recipientEmail, { role: 'recipient' })
  if (senderId === recipientId) {
    throw new Error(
      'Teams notification recipient cannot be the same as the Teams sender. Log in as a different user or change MS365_TEAMS_SENDER.'
    )
  }

  const chatId = await getOrCreateOneOnOneChat(senderId, recipientId)
  for (const chunk of chunks) {
    await sendTeamsChatMessage(chatId, chunk)
  }
}

export { isTeamsChatConfigured, sendTeamsChatMessages, diagnoseTeamsSetup }
