import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { Activity } from '../models/Activity.js'
import { generateWeeklyQualityReport } from '../services/activityReporting.js'

const router = Router()

// POST /api/activities
// Body: { rawText: string, structured: any, images?: string[] }
// Saves a new Activity linked to the logged-in user.
router.post('/', protectRoute, async (req, res, next) => {
  try {
    const { rawText, structured, images } = req.body || {}

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
      activityPayload.images = images.filter((url) => typeof url === 'string' && url.trim())
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

    const filter = { userId: req.user._id, isArchived: false }
    const [activities, total] = await Promise.all([
      Activity.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select({ customer: 1, summary: 1, createdAt: 1 })
        .lean(),
      Activity.countDocuments(filter),
    ])

    const totalPages = Math.ceil(total / limit)
    res.json({ activities, total, page, limit, totalPages })
  } catch (err) {
    next(err)
  }
})

// GET /api/activities/admin
// Admin: view all employee activity with optional filters. Paginated.
// Query: userId, customer, from, to, limit, page
router.get('/admin', protectRoute, requireRole('admin', 'supervisor'), async (req, res, next) => {
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
// Query: userId, customer, from, to, limit, archived
router.get('/admin/export', protectRoute, requireRole('admin', 'supervisor'), async (req, res, next) => {
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
      .select({ customer: 1, summary: 1, createdAt: 1, isArchived: 1, userId: 1 })
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
      'summary',
      'status',
    ]

    const rows = activities.map((a) => {
      const user = a.userId || {}
      return [
        a._id,
        a.createdAt ? new Date(a.createdAt).toISOString() : '',
        user.name || '',
        user.email || '',
        user.role || '',
        a.customer || '',
        a.summary || '',
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

// GET /api/activities/admin/archived - must be before /:id
router.get('/admin/archived', protectRoute, requireRole('admin', 'supervisor'), async (req, res, next) => {
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
        .select({ customer: 1, summary: 1, createdAt: 1, archivedAt: 1, userId: 1 })
        .lean(),
      Activity.countDocuments(filter),
    ])

    const totalPages = Math.ceil(total / limit)
    res.json({ activities, total, page, limit, totalPages })
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

    const isOwner = String(activity.userId) === String(req.user._id)
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

    const isOwner = String(activity.userId) === String(req.user._id)
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

// GET /api/activities/:id
// Returns a single activity with full raw + structured data.
router.get('/:id', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: 'Activity id is required' })
    }

    const activity = await Activity.findById(id).lean()

    if (!activity || activity.isArchived) {
      return res.status(404).json({ error: 'Activity not found' })
    }

    const isOwner = String(activity.userId) === String(req.user._id)
    const isAdmin = req.user.role === 'admin'

    if (!isOwner && !isAdmin) {
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
router.post('/admin/weekly-report', protectRoute, requireRole('admin', 'supervisor'), async (req, res, next) => {
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
      .select({ customer: 1, summary: 1, createdAt: 1, structuredData: 1, userId: 1 })
      .lean()

    const report = await generateWeeklyQualityReport(activities, { from, to })

    res.json({ report })
  } catch (err) {
    next(err)
  }
})

export { router as activitiesRouter }

