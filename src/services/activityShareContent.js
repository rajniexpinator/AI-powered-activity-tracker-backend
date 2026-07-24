import { formatUsDateTime } from '../utils/formatDate.js'
import { resolveSharePreferences } from '../constants/sharePreferences.js'

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function severityLabel(raw) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN
  if (n === 0) return '0 — All good'
  if (n === 1) return '1 — Low'
  if (n === 2) return '2 — Medium'
  if (n === 3) return '3 — High'
  return ''
}

function isVideoAttachment(a) {
  const mime = (a?.mime ?? '').toLowerCase()
  if (mime.startsWith('video/')) return true
  const path = `${a?.name ?? ''} ${a?.url ?? ''}`.toLowerCase()
  return /\.(mp4|mov|webm|m4v|ogv|ogg)(\?|#|$)/.test(path)
}

function asAttachmentUrl(a) {
  return a && typeof a.url === 'string' ? a.url.trim() : ''
}

/**
 * Build plain-text body for sharing/emailing an activity log.
 * @param {object} activity
 * @param {object} [user] - for share preference resolution
 * @param {{ photoLinkLines?: string[], attachedImageCount?: number, attachedFileCount?: number }} [opts]
 */
export function buildActivityShareText(activity, user, opts = {}) {
  const prefs = resolveSharePreferences(user).activityLog
  const structured =
    activity?.structuredData && typeof activity.structuredData === 'object' ? activity.structuredData : {}

  const customer = asText(activity?.customer) || asText(structured.customer) || 'Unknown customer'
  const summary = asText(activity?.summary) || asText(structured.summary) || 'No summary'
  const partName = asText(structured.part_name) || asText(structured.partName)
  const partNumber = asText(structured.part_number) || asText(structured.partNumber)
  const rawText = asText(activity?.rawConversation)
  const createdLabel = activity?.createdAt ? formatUsDateTime(activity.createdAt) : 'Unknown date'

  const lines = ['Apex Quality — AI activity log', '']

  if (prefs.customer) lines.push(`Customer: ${customer}`)
  if (prefs.createdAt) lines.push(`Created: ${createdLabel}`)
  if (prefs.summary) lines.push(`Summary: ${summary}`)
  if (prefs.partName && partName) lines.push(`Part name: ${partName}`)
  if (prefs.partNumber && partNumber) lines.push(`Part number: ${partNumber}`)

  if (prefs.summary || rawText) {
    lines.push('', 'Notes:', rawText || '(none)')
  }

  const photoLines = Array.isArray(opts.photoLinkLines) ? opts.photoLinkLines.filter(Boolean) : []
  const attachedImageCount = opts.attachedImageCount ?? 0
  if (prefs.photos && photoLines.length > 0) {
    const header =
      attachedImageCount > 0
        ? 'Photos are attached above in this message. Tap a link below for full resolution:'
        : 'Photos (tap a link to open full size):'
    lines.push('', '—', header, ...photoLines)
  }

  const attachments = Array.isArray(activity?.attachments) ? activity.attachments : []
  const docs = attachments.filter((a) => asAttachmentUrl(a) && !isVideoAttachment(a))
  const videos = attachments.filter((a) => asAttachmentUrl(a) && isVideoAttachment(a))
  const attachedFileCount = opts.attachedFileCount ?? 0

  if (prefs.files && docs.length > 0) {
    const header =
      attachedFileCount > 0
        ? 'Files are attached above in this message. Tap a link below if a file is missing:'
        : 'Files (tap a link to open):'
    lines.push('', '—', header)
    for (const f of docs) {
      const label = asText(f.name)
      const url = asAttachmentUrl(f)
      lines.push(label ? `${label}\n${url}` : url)
    }
  }

  if (prefs.files && videos.length > 0) {
    lines.push('', '—', 'Videos (tap a link to open):')
    for (const v of videos) {
      const label = asText(v.name)
      const url = asAttachmentUrl(v)
      lines.push(label ? `${label}\n${url}` : url)
    }
  }

  const datePart = activity?.createdAt
    ? new Date(activity.createdAt).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10)

  return {
    title: `AI log - ${customer} - ${datePart}`,
    text: lines.join('\n'),
    includeImageAttachments: Boolean(prefs.photos),
    includeFileAttachments: Boolean(prefs.files),
  }
}
