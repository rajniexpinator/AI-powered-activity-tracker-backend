/**
 * Build a bounded list of activity image URLs for weekly report thumbnails (web + PDF).
 */

const MAX_GALLERY_ACTIVITIES = 45
const MAX_IMAGES_PER_ACTIVITY = 6

export function isSafeReportImageUrl(url) {
  if (typeof url !== 'string') return false
  const u = url.trim()
  if (!u || u.length > 2048) return false
  if (!/^https?:\/\//i.test(u)) return false
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * @param {Array<{ _id?: unknown, customer?: string, summary?: string, createdAt?: Date|string, images?: string[] }>} activities
 * @returns {Array<{ activityId: import('mongoose').Types.ObjectId|string, customer: string, summary: string, createdAt?: Date, imageUrls: string[] }>}
 */
export function buildReportImageGallery(activities) {
  if (!Array.isArray(activities)) return []
  const items = []
  for (const a of activities) {
    if (items.length >= MAX_GALLERY_ACTIVITIES) break
    const imgs = Array.isArray(a.images) ? a.images : []
    const urls = imgs.filter(isSafeReportImageUrl).slice(0, MAX_IMAGES_PER_ACTIVITY)
    if (urls.length === 0) continue
    const summary = typeof a.summary === 'string' ? a.summary.slice(0, 280) : ''
    const customer = typeof a.customer === 'string' ? a.customer.slice(0, 160) : ''
    items.push({
      activityId: a._id,
      customer,
      summary,
      createdAt: a.createdAt,
      imageUrls: urls,
    })
  }
  return items
}
