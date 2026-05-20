/**
 * Build free-form WhatsApp chunks for a customer after they reply (24h session).
 * Used with WhatsAppPendingDelivery — template first, then flush on inbound webhook.
 */

export function canUserViewActivityForWhatsApp(activity, user) {
  if (!activity || activity.isArchived || !user) return false
  return true
}

function formatLocalDateTime(value) {
  const dt = value ? new Date(value) : new Date()
  if (Number.isNaN(dt.getTime())) return ''
  return dt.toLocaleString()
}

function splitMessage(text, chunkSize = 1400) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (!source) return []
  if (source.length <= chunkSize) return [source]
  const out = []
  let cursor = 0
  while (cursor < source.length) {
    out.push(source.slice(cursor, cursor + chunkSize))
    cursor += chunkSize
  }
  return out
}

export function buildCustomerShareWhatsAppMessages(activity) {
  if (!activity) return []
  const customer =
    typeof activity.customer === 'string' && activity.customer.trim() ? activity.customer.trim() : 'Customer'
  const summary =
    typeof activity.summary === 'string' && activity.summary.trim() ? activity.summary.trim() : 'Activity update'
  const location =
    typeof activity.location === 'string' && activity.location.trim() ? activity.location.trim() : '-'
  const created = formatLocalDateTime(activity.createdAt)
  const rawConversation =
    typeof activity.rawConversation === 'string' && activity.rawConversation.trim()
      ? activity.rawConversation.trim()
      : summary

  const header =
    `AI activity log\n` +
    `Customer: ${customer}\n` +
    `Location: ${location}\n` +
    `Summary: ${summary}\n` +
    (created ? `Created: ${created}\n` : '') +
    `Log ID: ${String(activity._id)}`

  const attachmentUrls = [
    ...(Array.isArray(activity.images) ? activity.images : []),
    ...(Array.isArray(activity.attachments) ? activity.attachments.map((a) => a?.url).filter(Boolean) : []),
  ]
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => url.trim())

  const messages = [header, ...splitMessage(`Full log:\n${rawConversation}`)]
  if (attachmentUrls.length > 0) {
    messages.push(...splitMessage(`Photos & files (open links):\n${attachmentUrls.join('\n')}`))
  }
  return messages.filter(Boolean)
}
