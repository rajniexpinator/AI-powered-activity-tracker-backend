import { Router } from 'express'
import mongoose from 'mongoose'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { Activity } from '../models/Activity.js'
import { Customer } from '../models/Customer.js'
import { User } from '../models/User.js'
import { getDefaultMs365Recipients } from '../services/ms365Recipients.js'
import { Report } from '../models/Report.js'
import { generateWeeklyQualityReport } from '../services/activityReporting.js'
import { buildReportImageGallery } from '../services/reportImageGallery.js'
import { interpretActivityQuestion, buildActivityFilterFromPlan } from '../services/activityAiQuery.js'
import { generateActivityAnswer } from '../services/activityAiAnswer.js'
import { isMsGraphConfigured, createMs365Draft, sendMs365Draft } from '../services/msGraphMail.js'
import {
  addDays,
  buildWeeklyActivityExcelBuffer,
  enumerateWeekMondays,
  getMondayOfWeekContaining,
  groupActivitiesByCustomer,
} from '../services/weeklyActivityExcel.js'

const router = Router()
const MAX_IMAGES_PER_ENTRY = 8
const MAX_ATTACHMENTS_PER_ENTRY = 10
const MAX_MS365_ATTACHMENT_BYTES = 3 * 1024 * 1024
const MAX_SHARED_USERS = 30
const MAX_COLLAB_NOTES = 200

/** User id whether ref is an ObjectId, string, or populated { _id, name, ... } */
function refToId(ref) {
  if (ref == null) return ''
  if (typeof ref === 'object' && ref !== null && ref._id != null) return String(ref._id)
  return String(ref)
}

function isCollaborator(activity, user) {
  if (!activity || !user) return false
  const uid = String(user._id)
  const shared = Array.isArray(activity.sharedWith) ? activity.sharedWith : []
  return shared.some((entry) => refToId(entry) === uid)
}

function canViewActivity(activity, user) {
  if (!activity || activity.isArchived) return false
  if (user.role === 'admin') return true
  if (refToId(activity.userId) === String(user._id)) return true
  return isCollaborator(activity, user)
}

/** Optional filter: structuredData.severity is 1 (low), 2 (medium), or 3 (high). Query: severity=3 or minSeverity=2 */
function applyStructuredSeverityFilter(filter, query) {
  if (!query || typeof query !== 'object') return
  let exact = NaN
  if (typeof query.severity === 'string' && query.severity.trim()) {
    exact = parseInt(query.severity.trim(), 10)
  }
  if (!Number.isNaN(exact) && exact >= 1 && exact <= 3) {
    filter['structuredData.severity'] = exact
    return
  }
  let minSev = NaN
  if (typeof query.minSeverity === 'string' && query.minSeverity.trim()) {
    minSev = parseInt(query.minSeverity.trim(), 10)
  }
  if (!Number.isNaN(minSev) && minSev >= 1 && minSev <= 3) {
    filter['structuredData.severity'] = { $gte: minSev }
  }
}

function normalizeEmailList(value) {
  if (!value) return []
  const arr = Array.isArray(value) ? value : [value]
  return arr
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

function sanitizeFilename(name, fallback = 'attachment') {
  if (typeof name !== 'string') return fallback
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  return cleaned || fallback
}

function filenameFromUrl(rawUrl, fallback = 'attachment') {
  try {
    const u = new URL(rawUrl)
    const decoded = decodeURIComponent(u.pathname.split('/').pop() || '')
    return sanitizeFilename(decoded || fallback, fallback)
  } catch {
    return fallback
  }
}

async function fetchRemoteAttachment({ url, fallbackName, preferredName, preferredMime }) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`)
  }

  const contentType = (
    (typeof preferredMime === 'string' && preferredMime.trim()) ||
    response.headers.get('content-type') ||
    'application/octet-stream'
  ).split(';')[0]

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) {
    throw new Error('Downloaded file is empty')
  }
  if (buffer.length > MAX_MS365_ATTACHMENT_BYTES) {
    throw new Error(
      `File exceeds ${Math.floor(MAX_MS365_ATTACHMENT_BYTES / (1024 * 1024))} MB attachment limit for Microsoft 365 draft API`
    )
  }

  const name =
    sanitizeFilename(preferredName || '', '') ||
    sanitizeFilename(filenameFromUrl(url, fallbackName), fallbackName)

  return {
    name,
    contentType,
    contentBytesBase64: buffer.toString('base64'),
  }
}

function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return undefined
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (!url) continue
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 220) : 'file'
    const mime = typeof item.mime === 'string' ? item.mime.trim().slice(0, 120) : ''
    const size = typeof item.size === 'number' && item.size >= 0 ? Math.floor(item.size) : undefined
    out.push({ url, name: name || 'file', mime, ...(size !== undefined ? { size } : {}) })
    if (out.length >= MAX_ATTACHMENTS_PER_ENTRY) break
  }
  return out
}

// POST /api/activities
// Body: { rawText: string, structured: any, images?: string[] }
// Saves a new Activity linked to the logged-in user.
router.post('/', protectRoute, async (req, res, next) => {
  try {
    const { rawText, structured, images, attachments } = req.body || {}

    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      return res.status(400).json({ error: 'rawText is required and must be a non-empty string' })
    }

    if (!structured || typeof structured !== 'object') {
      return res.status(400).json({ error: 'structured is required and must be an object' })
    }

    const summary =
      typeof structured.summary === 'string' && structured.summary.trim()
        ? structured.summary.trim()
        : rawText.slice(0, 160)

    const customer =
      typeof structured.customer === 'string' && structured.customer.trim()
        ? structured.customer.trim()
        : undefined

    const activityPayload = {
      userId: req.user._id,
      customer,
      summary,
      rawConversation: rawText,
      structuredData: structured,
    }

    if (Array.isArray(images)) {
      const cleanedImages = images.filter((url) => typeof url === 'string' && url.trim())
      if (cleanedImages.length > MAX_IMAGES_PER_ENTRY) {
        return res
          .status(400)
          .json({ error: `A maximum of ${MAX_IMAGES_PER_ENTRY} images is allowed per activity.` })
      }
      activityPayload.images = cleanedImages
    }

    if (Array.isArray(attachments)) {
      if (attachments.length > MAX_ATTACHMENTS_PER_ENTRY) {
        return res
          .status(400)
          .json({ error: `A maximum of ${MAX_ATTACHMENTS_PER_ENTRY} attachments is allowed per activity.` })
      }
      activityPayload.attachments = normalizeAttachments(attachments) ?? []
    }

    const activity = await Activity.create(activityPayload)

    res.status(201).json({ activity })
  } catch (err) {
    next(err)
  }
})

// GET /api/activities
// Query (optional): limit (default 20), page (default 1)
// Returns recent activities for the logged-in user, newest first. Paginated.
router.get('/', protectRoute, async (req, res, next) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100)
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1)
    const skip = (page - 1) * limit

    const uid = req.user._id
    const filter = {
      isArchived: false,
      $or: [{ userId: uid }, { sharedWith: uid }],
    }
    const [rows, total] = await Promise.all([
      Activity.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select({ customer: 1, summary: 1, createdAt: 1, userId: 1 })
        .lean(),
      Activity.countDocuments(filter),
    ])

    const activities = rows.map((a) => ({
      _id: a._id,
      customer: a.customer,
      summary: a.summary,
      createdAt: a.createdAt,
      isOwner: String(a.userId) === String(uid),
    }))

    const totalPages = Math.ceil(total / limit)
    res.json({ activities, total, page, limit, totalPages })
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/today-count
// Returns how many activities were created today for the logged-in user.
router.get('/today-count', protectRoute, async (req, res, next) => {
  try {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)

    const filter = {
      userId: req.user._id,
      isArchived: false,
      createdAt: { $gte: start, $lt: end },
    }

    const todayCount = await Activity.countDocuments(filter)
    res.json({ todayCount })
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/admin
// Admin: view all employee activity with optional filters. Paginated.
// Query: userId, customer, from, to, limit, page, severity, minSeverity
router.get('/admin', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { userId, customer, from, to } = req.query

    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 200)
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1)
    const skip = (page - 1) * limit

    const filter = { isArchived: false }

    if (typeof userId === 'string' && userId) {
      filter.userId = userId
    }

    if (typeof customer === 'string' && customer.trim()) {
      filter.customer = customer.trim()
    }

    applyStructuredSeverityFilter(filter, req.query)

    if (typeof from === 'string' || typeof to === 'string') {
      const createdAt = {}
      if (typeof from === 'string' && from) {
        const fromDate = new Date(from)
        if (!Number.isNaN(fromDate.getTime())) {
          createdAt.$gte = fromDate
        }
      }
      if (typeof to === 'string' && to) {
        const toDate = new Date(to)
        if (!Number.isNaN(toDate.getTime())) {
          // include entire day if only a date is passed
          createdAt.$lte = toDate
        }
      }
      if (Object.keys(createdAt).length > 0) {
        filter.createdAt = createdAt
      }
    }

    const [activities, total] = await Promise.all([
      Activity.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'name email role')
        .select({ customer: 1, summary: 1, createdAt: 1, structuredData: 1, userId: 1 })
        .lean(),
      Activity.countDocuments(filter),
    ])

    const totalPages = Math.ceil(total / limit)
    res.json({ activities, total, page, limit, totalPages })
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/admin/export
// Admin/Supervisor: export filtered activity as CSV.
// Query: userId, customer, from, to, limit, archived, severity, minSeverity
router.get('/admin/export', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { userId, customer, from, to } = req.query

    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 1000 : rawLimit, 1), 5000)
    const includeArchived = req.query.archived === 'true'

    const filter = { isArchived: includeArchived }

    if (typeof userId === 'string' && userId) {
      filter.userId = userId
    }

    if (typeof customer === 'string' && customer.trim()) {
      filter.customer = customer.trim()
    }

    applyStructuredSeverityFilter(filter, req.query)

    if (typeof from === 'string' || typeof to === 'string') {
      const createdAt = {}
      if (typeof from === 'string' && from) {
        const fromDate = new Date(from)
        if (!Number.isNaN(fromDate.getTime())) {
          createdAt.$gte = fromDate
        }
      }
      if (typeof to === 'string' && to) {
        const toDate = new Date(to)
        if (!Number.isNaN(toDate.getTime())) {
          createdAt.$lte = toDate
        }
      }
      if (Object.keys(createdAt).length > 0) {
        filter.createdAt = createdAt
      }
    }

    const activities = await Activity.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'name email role')
      .select({ customer: 1, summary: 1, createdAt: 1, isArchived: 1, userId: 1, structuredData: 1 })
      .lean()

    const esc = (value) => {
      if (value === null || value === undefined) return '""'
      const s = String(value).replace(/"/g, '""')
      return `"${s}"`
    }

    const header = [
      'id',
      'created_at',
      'employee_name',
      'employee_email',
      'employee_role',
      'customer',
      'issue',
      'resolution',
      'summary',
      'severity',
      'status',
    ]

    const rows = activities.map((a) => {
      const user = a.userId || {}
      const structured = a.structuredData && typeof a.structuredData === 'object' ? a.structuredData : {}
      const issue =
        structured.issue ||
        structured.problem ||
        structured.concern ||
        structured.activity_type ||
        ''
      const resolution =
        structured.resolution ||
        structured.outcome ||
        structured.action_taken ||
        ''
      const rawSev = structured.severity
      const sevNum = typeof rawSev === 'number' ? rawSev : typeof rawSev === 'string' ? parseInt(rawSev, 10) : NaN
      const severity =
        sevNum === 1 ? '1_low' : sevNum === 2 ? '2_medium' : sevNum === 3 ? '3_high' : ''
      return [
        a._id,
        a.createdAt ? new Date(a.createdAt).toISOString() : '',
        user.name || '',
        user.email || '',
        user.role || '',
        a.customer || '',
        issue,
        resolution,
        a.summary || '',
        severity,
        a.isArchived ? 'archived' : 'active',
      ]
    })

    const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n')

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="activities-export.csv"')
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/admin/export/weekly-xlsx
// Admin: timesheet-style Excel — one worksheet per customer.
// When both from & to are set: same window as AI weekly report (multi-week = stacked week blocks per tab).
// Otherwise: single calendar week containing weekEnd (or to, or from, or today).
// Query: userId, customer, from, to, archived, weekEnd, program | vehicleProgram, severity, minSeverity
router.get('/admin/export/weekly-xlsx', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { userId, customer, from, to } = req.query
    const includeArchived = req.query.archived === 'true'
    const programOverride =
      (typeof req.query.program === 'string' && req.query.program.trim()) ||
      (typeof req.query.vehicleProgram === 'string' && req.query.vehicleProgram.trim()) ||
      ''

    const filter = { isArchived: includeArchived }

    if (typeof userId === 'string' && userId) {
      filter.userId = userId
    }

    if (typeof customer === 'string' && customer.trim()) {
      filter.customer = customer.trim()
    }

    applyStructuredSeverityFilter(filter, req.query)

    const hasFrom = typeof from === 'string' && from.trim()
    const hasTo = typeof to === 'string' && to.trim()
    let weekMondays
    let periodSummary
    let fnameStem

    if (hasFrom && hasTo) {
      const fromDate = new Date(from)
      const toDate = new Date(to)
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ error: 'Invalid from or to date' })
      }
      fromDate.setHours(0, 0, 0, 0)
      toDate.setHours(23, 59, 59, 999)
      filter.createdAt = { $gte: fromDate, $lte: toDate }
      weekMondays = enumerateWeekMondays(fromDate, toDate)
      if (weekMondays.length === 0) {
        weekMondays = [getMondayOfWeekContaining(fromDate)]
      }
      periodSummary = `Reporting period: ${String(from).slice(0, 10)} to ${String(to).slice(0, 10)} — same filters as Generate weekly AI report.`
      fnameStem = `${String(from).slice(0, 10)}_to_${String(to).slice(0, 10)}`
    } else {
      const rawWeekEnd =
        typeof req.query.weekEnd === 'string' && req.query.weekEnd.trim()
          ? req.query.weekEnd.trim()
          : hasTo
            ? to
            : hasFrom
              ? from
              : null

      const anchor = rawWeekEnd ? new Date(rawWeekEnd) : new Date()
      if (Number.isNaN(anchor.getTime())) {
        return res.status(400).json({ error: 'Invalid weekEnd — use YYYY-MM-DD' })
      }
      anchor.setHours(12, 0, 0, 0)

      const weekMonday = getMondayOfWeekContaining(anchor)
      const weekSundayEnd = addDays(weekMonday, 6)
      weekSundayEnd.setHours(23, 59, 59, 999)

      filter.createdAt = { $gte: weekMonday, $lte: weekSundayEnd }
      weekMondays = [weekMonday]
      periodSummary = `Single week (Mon–Sun) containing ${String(rawWeekEnd || anchor.toISOString().slice(0, 10)).slice(0, 10)}.`
      fnameStem = weekMonday.toISOString().slice(0, 10)
    }

    const activities = await Activity.find(filter)
      .sort({ createdAt: 1 })
      .populate('userId', 'name email role')
      .select({
        customer: 1,
        summary: 1,
        rawConversation: 1,
        createdAt: 1,
        isArchived: 1,
        userId: 1,
        structuredData: 1,
      })
      .lean()

    const byCustomer = groupActivitiesByCustomer(activities)

    const buffer = await buildWeeklyActivityExcelBuffer({
      byCustomer,
      weekMondays,
      program: programOverride,
      periodSummary,
    })

    const fname = `weekly-activity-report-${fnameStem}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`)
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/admin/archived - must be before /:id
// Query: userId, customer, from, to, limit, page, severity, minSeverity
router.get('/admin/archived', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { userId, customer, from, to } = req.query

    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 200)
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1)
    const skip = (page - 1) * limit

    const filter = { isArchived: true }

    if (typeof userId === 'string' && userId) filter.userId = userId
    if (typeof customer === 'string' && customer.trim()) filter.customer = customer.trim()
    applyStructuredSeverityFilter(filter, req.query)
    if (typeof from === 'string' || typeof to === 'string') {
      const createdAt = {}
      if (typeof from === 'string' && from) {
        const fromDate = new Date(from)
        if (!Number.isNaN(fromDate.getTime())) createdAt.$gte = fromDate
      }
      if (typeof to === 'string' && to) {
        const toDate = new Date(to)
        if (!Number.isNaN(toDate.getTime())) createdAt.$lte = toDate
      }
      if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt
    }

    const [activities, total] = await Promise.all([
      Activity.find(filter)
        .sort({ archivedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'name email role')
        .select({ customer: 1, summary: 1, createdAt: 1, archivedAt: 1, userId: 1, structuredData: 1 })
        .lean(),
      Activity.countDocuments(filter),
    ])

    const totalPages = Math.ceil(total / limit)
    res.json({ activities, total, page, limit, totalPages })
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/admin/:id
// Admin-only detail endpoint that can return archived activities too.
router.get('/admin/:id', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: 'Activity id is required' })
    }

    const activity = await Activity.findById(id).lean()
    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    res.json({ activity })
  } catch (err) {
    next(err)
  }
})

// POST /api/activities/:id/restore
router.post('/:id/restore', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'Activity id is required' })

    const activity = await Activity.findById(id)
    if (!activity || !activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found or not archived' })
    }

    const isOwner = refToId(activity.userId) === String(req.user._id)
    const isAdmin = req.user.role === 'admin'
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden — you cannot restore this activity' })
    }

    activity.isArchived = false
    activity.archivedAt = undefined
    await activity.save()
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/activities/:id/archive
// Marks a single activity as archived (owner or admin only).
router.post('/:id/archive', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: 'Activity id is required' })
    }

    const activity = await Activity.findById(id)

    if (!activity || activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    const isOwner = refToId(activity.userId) === String(req.user._id)
    const isAdmin = req.user.role === 'admin'

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden — you cannot archive this activity' })
    }

    activity.isArchived = true
    activity.archivedAt = new Date()
    await activity.save()

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/activities/:id/share
// Owner or admin: set which coworkers can view and comment on this log.
router.patch('/:id/share', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params
    const { sharedWithUserIds } = req.body || {}
    if (!id) return res.status(400).json({ error: 'Activity id is required' })
    if (!Array.isArray(sharedWithUserIds)) {
      return res.status(400).json({ error: 'sharedWithUserIds must be an array' })
    }

    const activity = await Activity.findById(id)
    if (!activity || activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    const isOwner = refToId(activity.userId) === String(req.user._id)
    const isAdmin = req.user.role === 'admin'
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden — only the log owner can update sharing' })
    }

    const unique = [
      ...new Set(
        sharedWithUserIds
          .filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())
      ),
    ]
    if (unique.length > MAX_SHARED_USERS) {
      return res.status(400).json({ error: `You can share with at most ${MAX_SHARED_USERS} coworkers.` })
    }

    const validIds = unique.filter((x) => mongoose.Types.ObjectId.isValid(x)).map((x) => new mongoose.Types.ObjectId(x))
    const ownerId = refToId(activity.userId)
    const candidateIds = validIds.filter((oid) => String(oid) !== ownerId)

    const activeUsers = await User.find({
      _id: { $in: candidateIds },
      isActive: true,
    })
      .select('_id')
      .lean()

    activity.sharedWith = activeUsers.map((u) => u._id)
    await activity.save()

    const populated = await Activity.findById(activity._id)
      .populate('sharedWith', 'name email role')
      .populate('userId', 'name email role')
      .lean()

    res.json({ activity: populated })
  } catch (err) {
    next(err)
  }
})

// POST /api/activities/:id/notes
// Owner, admin, or anyone in sharedWith can append a collaboration note.
router.post('/:id/notes', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params
    const { text } = req.body || {}
    if (!id) return res.status(400).json({ error: 'Activity id is required' })
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' })
    }
    const safeText = text.trim()
    if (safeText.length > 12000) {
      return res.status(400).json({ error: 'Note is too long' })
    }

    const activity = await Activity.findById(id).lean()
    if (!activity || activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    if (!canViewActivity(activity, req.user)) {
      return res.status(403).json({ error: 'Forbidden — you cannot access this activity' })
    }

    const isOwner = refToId(activity.userId) === String(req.user._id)
    const isAdmin = req.user.role === 'admin'
    if (!isOwner && !isAdmin && !isCollaborator(activity, req.user)) {
      return res.status(403).json({ error: 'Forbidden — only collaborators can add notes on this log' })
    }

    const n = Array.isArray(activity.collaborationNotes) ? activity.collaborationNotes.length : 0
    if (n >= MAX_COLLAB_NOTES) {
      return res.status(400).json({ error: 'Maximum notes on this log reached' })
    }

    const updated = await Activity.findByIdAndUpdate(
      id,
      {
        $push: {
          collaborationNotes: {
            userId: req.user._id,
            text: safeText,
            createdAt: new Date(),
          },
        },
      },
      { new: true }
    )
      .populate('collaborationNotes.userId', 'name email role')
      .populate('sharedWith', 'name email role')
      .populate('userId', 'name email role')
      .lean()

    res.json({ activity: updated })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/activities/:id
// Permanent delete for archived activities only ("archive protection").
// Allowed if: activity.isArchived === true AND (owner OR admin).
router.delete('/:id', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: 'Activity id is required' })
    }

    const activity = await Activity.findById(id).lean()
    if (!activity) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    if (!activity.isArchived) {
      return res.status(400).json({ error: 'Only archived activities can be permanently deleted' })
    }

    const isOwner = refToId(activity.userId) === String(req.user._id)
    const isPrivileged = ['admin'].includes(req.user.role)

    if (!isOwner && !isPrivileged) {
      return res.status(403).json({ error: 'Forbidden — you cannot delete this activity' })
    }

    await Activity.deleteOne({ _id: id })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/activities/:id
// Update an existing activity (owner or admin), for past-submission edits.
// Body (at least one): { rawText?: string, structured?: any, images?: string[] }
router.patch('/:id', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ error: 'Activity id is required' })
    }

    const activity = await Activity.findById(id)
    if (!activity || activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    const isOwner = refToId(activity.userId) === String(req.user._id)
    const isAdmin = req.user.role === 'admin'
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden — you cannot edit this activity' })
    }

    const { rawText, structured, images, attachments } = req.body || {}
    const hasRawText = typeof rawText === 'string'
    const hasStructured = structured && typeof structured === 'object'
    const hasImages = Array.isArray(images)
    const hasAttachments = Array.isArray(attachments)

    if (!hasRawText && !hasStructured && !hasImages && !hasAttachments) {
      return res
        .status(400)
        .json({ error: 'Provide at least one field to update: rawText, structured, images, or attachments' })
    }

    if (hasRawText) {
      if (!rawText.trim()) {
        return res.status(400).json({ error: 'rawText must be a non-empty string' })
      }
      activity.rawConversation = rawText.trim()
    }

    if (hasStructured) {
      activity.structuredData = structured

      const nextSummary =
        typeof structured.summary === 'string' && structured.summary.trim()
          ? structured.summary.trim()
          : (activity.rawConversation || '').slice(0, 160)
      activity.summary = nextSummary

      const nextCustomer =
        typeof structured.customer === 'string' && structured.customer.trim()
          ? structured.customer.trim()
          : undefined
      activity.customer = nextCustomer
    } else if (hasRawText) {
      // Keep summary consistent if only raw text changed.
      activity.summary = (activity.rawConversation || '').slice(0, 160)
    }

    if (hasImages) {
      const cleanedImages = images.filter((url) => typeof url === 'string' && url.trim())
      if (cleanedImages.length > MAX_IMAGES_PER_ENTRY) {
        return res
          .status(400)
          .json({ error: `A maximum of ${MAX_IMAGES_PER_ENTRY} images is allowed per activity.` })
      }
      activity.images = cleanedImages
    }

    if (hasAttachments) {
      if (attachments.length > MAX_ATTACHMENTS_PER_ENTRY) {
        return res
          .status(400)
          .json({ error: `A maximum of ${MAX_ATTACHMENTS_PER_ENTRY} attachments is allowed per activity.` })
      }
      activity.attachments = normalizeAttachments(attachments) ?? []
    }

    await activity.save()
    res.json({ activity })
  } catch (err) {
    next(err)
  }
})

// POST /api/activities/admin/ai-query
// Admin: natural-language search over activities (e.g. "Bosch issues last week").
// Body: { question: string, limit?: number }
router.post('/admin/ai-query', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { question, limit } = req.body || {}
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' })
    }

    const rawLimit = typeof limit === 'number' ? limit : NaN
    const max = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 100)

    const custRows = await Customer.find().select('name').lean().limit(200)
    const names = custRows.map((c) => c.name).filter(Boolean)

    const plan = await interpretActivityQuestion(question.trim(), names)
    const filter = buildActivityFilterFromPlan(plan)

    const activities = await Activity.find(filter)
      .sort({ createdAt: -1 })
      .limit(max)
      .populate('userId', 'name email role')
      .select({
        customer: 1,
        summary: 1,
        rawConversation: 1,
        createdAt: 1,
        isArchived: 1,
        userId: 1,
        structuredData: 1,
      })
      .lean()

    const answer =
      activities.length > 0
        ? await generateActivityAnswer(question.trim(), plan.interpretation, plan, activities)
        : `No matching activities found for this question. Try broader wording (for example remove a part name or keyword).`

    res.json({
      interpretation: typeof plan.interpretation === 'string' ? plan.interpretation : '',
      count: activities.length,
      activities,
      answer,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/activities/admin/ai-weekly-report
// Admin: question -> interpreted filters -> generate weekly report narrative.
// Body: { question: string, limit?: number }
router.post('/admin/ai-weekly-report', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { question, limit } = req.body || {}
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' })
    }

    const rawLimit = typeof limit === 'number' ? limit : NaN
    const max = Math.min(Math.max(Number.isNaN(rawLimit) ? 200 : rawLimit, 1), 500)

    const custRows = await Customer.find().select('name').lean().limit(200)
    const names = custRows.map((c) => c.name).filter(Boolean)

    const plan = await interpretActivityQuestion(question.trim(), names)
    const filter = buildActivityFilterFromPlan(plan)

    const activities = await Activity.find(filter)
      .sort({ createdAt: -1 })
      .limit(max)
      .populate('userId', 'name email role')
      .select({
        customer: 1,
        summary: 1,
        rawConversation: 1,
        createdAt: 1,
        isArchived: 1,
        userId: 1,
        structuredData: 1,
        images: 1,
      })
      .lean()

    const report = await generateWeeklyQualityReport(activities, {
      from: plan.from || undefined,
      to: plan.to || undefined,
      includeCustomerSummaries: false,
    })

    const imageGallery = buildReportImageGallery(activities)

    const saved = await Report.create({
      createdBy: req.user._id,
      scopeRole: req.user.role,
      userId: undefined,
      customer: typeof plan.customerSubstring === 'string' && plan.customerSubstring.trim() ? plan.customerSubstring.trim() : undefined,
      from: plan.from ? new Date(plan.from) : undefined,
      to: plan.to ? new Date(plan.to) : undefined,
      includeCustomerSummaries: false,
      content: report,
      model: 'gpt-4o-mini',
      activityCount: activities.length,
      imageGallery: imageGallery.length ? imageGallery : undefined,
    })

    res.json({ report, reportId: saved._id, imageGallery })
  } catch (err) {
    next(err)
  }
})

// POST /api/activities/:id/send-email
// Sends one activity log by email, including images/files as message attachments.
router.post('/:id/send-email', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'Activity id is required' })
    if (!isMsGraphConfigured()) {
      return res.status(503).json({ error: 'Microsoft 365 mail is not configured on the server' })
    }

    const activity = await Activity.findById(id).lean()
    if (!activity || activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    if (!canViewActivity(activity, req.user)) {
      return res.status(403).json({ error: 'Forbidden — you cannot email this activity' })
    }

    const body = req.body || {}
    const providedTo = normalizeEmailList(body.to)
    const providedCc = normalizeEmailList(body.cc)
    const defaults = await getDefaultMs365Recipients()

    let recipientTo = [...providedTo]

    const activityCustomerName =
      typeof activity.customer === 'string' && activity.customer.trim() ? activity.customer.trim() : ''

    if (activityCustomerName) {
      const byCustomer = await Customer.findOne({
        name: {
          $regex: `^${activityCustomerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          $options: 'i',
        },
      })
        .select('email')
        .lean()

      if (!byCustomer) {
        return res.status(400).json({
          error:
            'Cannot send email: this log\'s customer is not linked in your directory. Add the customer under Customers or correct the name on this log.',
        })
      }

      const custEmail =
        typeof byCustomer.email === 'string' && byCustomer.email.trim()
          ? byCustomer.email.trim().toLowerCase()
          : ''
      if (!custEmail) {
        return res.status(400).json({
          error:
            'Cannot send email: no email is linked to this customer. Add an email for this customer in Customers, then try again.',
        })
      }

      if (!recipientTo.includes(custEmail)) recipientTo.push(custEmail)
    }

    for (const e of defaults.to) {
      if (e && !recipientTo.includes(e)) recipientTo.push(e)
    }
    recipientTo = [...new Set(recipientTo)]

    let ccMerged = [...providedCc]
    for (const e of defaults.cc) {
      if (e && !ccMerged.includes(e)) ccMerged.push(e)
    }
    ccMerged = [...new Set(ccMerged)]

    if (recipientTo.length === 0 && typeof req.user.email === 'string' && req.user.email.trim()) {
      recipientTo.push(req.user.email.trim().toLowerCase())
    }
    recipientTo = [...new Set(recipientTo)]

    if (recipientTo.length === 0) {
      return res
        .status(400)
        .json({
          error:
            'No recipients available. Set a customer email, configure default recipients (admin), or pass to[] in the request.',
        })
    }

    const createdLabel = activity.createdAt ? new Date(activity.createdAt).toLocaleString() : 'Unknown date'
    const safeCustomer = typeof activity.customer === 'string' && activity.customer.trim() ? activity.customer.trim() : 'Unknown customer'
    const safeSummary = typeof activity.summary === 'string' && activity.summary.trim() ? activity.summary.trim() : 'No summary'
    const rawText =
      typeof activity.rawConversation === 'string' && activity.rawConversation.trim()
        ? activity.rawConversation.trim()
        : ''

    const images = Array.isArray(activity.images) ? activity.images.filter((u) => typeof u === 'string' && u.trim()) : []
    const files = Array.isArray(activity.attachments) ? activity.attachments : []
    const allSources = [
      ...images.map((url, idx) => ({ url, fallbackName: `activity-image-${idx + 1}.jpg` })),
      ...files.map((a, idx) => ({
        url: a?.url,
        fallbackName: `activity-file-${idx + 1}`,
        preferredName: a?.name,
        preferredMime: a?.mime,
      })),
    ].filter((x) => typeof x.url === 'string' && x.url.trim())

    const preparedAttachments = []
    const skipped = []
    for (const source of allSources) {
      try {
        const prepared = await fetchRemoteAttachment({
          url: source.url,
          fallbackName: source.fallbackName,
          preferredName: source.preferredName,
          preferredMime: source.preferredMime,
        })
        preparedAttachments.push(prepared)
      } catch (err) {
        skipped.push({
          url: source.url,
          reason: err instanceof Error ? err.message : 'Failed to download attachment',
        })
      }
    }

    const skippedText =
      skipped.length > 0
        ? `\n\nSkipped attachments (${skipped.length}):\n${skipped.map((s) => `- ${s.url} (${s.reason})`).join('\n')}`
        : ''

    const textBody = [
      `Activity log export`,
      ``,
      `Customer: ${safeCustomer}`,
      `Created: ${createdLabel}`,
      `Summary: ${safeSummary}`,
      ``,
      `Raw notes:`,
      rawText || '(none)',
      ``,
      `Attached in this email: ${preparedAttachments.length}`,
      `Source links captured in log: ${allSources.length}`,
      skippedText,
    ].join('\n')

    const subject =
      typeof body.subject === 'string' && body.subject.trim()
        ? body.subject.trim()
        : `AI log - ${safeCustomer} - ${new Date(activity.createdAt || Date.now()).toISOString().slice(0, 10)}`

    const draft = await createMs365Draft({
      to: recipientTo,
      cc: ccMerged,
      subject,
      text: textBody,
      attachments: preparedAttachments,
    })
    await sendMs365Draft({ messageId: draft.id })

    res.json({
      success: true,
      to: recipientTo,
      cc: ccMerged,
      attachedCount: preparedAttachments.length,
      sourceCount: allSources.length,
      skipped,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/:id
// Returns a single activity with full raw + structured data.
router.get('/:id', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: 'Activity id is required' })
    }

    const activity = await Activity.findById(id)
      .populate('userId', 'name email role')
      .populate('sharedWith', 'name email role')
      .populate('collaborationNotes.userId', 'name email role')
      .lean()

    if (!activity || activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    if (!canViewActivity(activity, req.user)) {
      return res.status(403).json({ error: 'Forbidden — you cannot view this activity' })
    }

    res.json({ activity })
  } catch (err) {
    next(err)
  }
})

// POST /api/activities/admin/weekly-report
// Admin: generate a weekly quality report via AI for the filtered activities.
// Body: { userId?, customer?, from?, to?, limit? }
router.post('/admin/weekly-report', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { userId, customer, from, to, limit } = req.body || {}

    const rawLimit = typeof limit === 'number' ? limit : NaN
    const max = Math.min(Math.max(Number.isNaN(rawLimit) ? 200 : rawLimit, 1), 500)

    const filter = { isArchived: false }

    if (userId) {
      filter.userId = userId
    }

    if (typeof customer === 'string' && customer.trim()) {
      filter.customer = customer.trim()
    }

    if (from || to) {
      const createdAt = {}
      if (from) {
        const fromDate = new Date(from)
        if (!Number.isNaN(fromDate.getTime())) {
          createdAt.$gte = fromDate
        }
      }
      if (to) {
        const toDate = new Date(to)
        if (!Number.isNaN(toDate.getTime())) {
          createdAt.$lte = toDate
        }
      }
      if (Object.keys(createdAt).length > 0) {
        filter.createdAt = createdAt
      }
    }

    const activities = await Activity.find(filter)
      .sort({ createdAt: -1 })
      .limit(max)
      .populate('userId', 'name email role')
      .select({ customer: 1, summary: 1, createdAt: 1, structuredData: 1, rawConversation: 1, userId: 1, images: 1 })
      .lean()

    const report = await generateWeeklyQualityReport(activities, { from, to })
    const imageGallery = buildReportImageGallery(activities)

    res.json({ report, imageGallery })
  } catch (err) {
    next(err)
  }
})

export { router as activitiesRouter }

