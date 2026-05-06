import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { Activity } from '../models/Activity.js'
import { Report } from '../models/Report.js'
import { generateWeeklyQualityReport } from '../services/activityReporting.js'
import { buildReportImageGallery } from '../services/reportImageGallery.js'

const router = Router()

function parseDateOrUndefined(value) {
  if (typeof value !== 'string' || !value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function applyStructuredSeverityFilter(filter, query) {
  if (!query || typeof query !== 'object') return
  let exact = NaN
  if (typeof query.severity === 'string' && query.severity.trim()) {
    exact = parseInt(query.severity.trim(), 10)
  }
  if (!Number.isNaN(exact) && exact >= 0 && exact <= 3) {
    filter['structuredData.severity'] = exact
    return
  }
  let minSev = NaN
  if (typeof query.minSeverity === 'string' && query.minSeverity.trim()) {
    minSev = parseInt(query.minSeverity.trim(), 10)
  }
  if (!Number.isNaN(minSev) && minSev >= 0 && minSev <= 3) {
    filter['structuredData.severity'] = { $gte: minSev }
  }
}

function buildActivityFilter({ userId, customer, from, to, archived, severity, minSeverity }) {
  const filter = { isArchived: Boolean(archived) }
  if (typeof userId === 'string' && userId) filter.userId = userId
  if (typeof customer === 'string' && customer.trim()) filter.customer = customer.trim()
  if (from || to) {
    const createdAt = {}
    if (from) createdAt.$gte = from
    if (to) createdAt.$lte = to
    if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt
  }
  const q =
    severity != null || minSeverity != null
      ? { severity: severity != null ? String(severity) : undefined, minSeverity: minSeverity != null ? String(minSeverity) : undefined }
      : null
  applyStructuredSeverityFilter(filter, q)
  return filter
}


router.post('/generate', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { userId, customer, from, to, limit, includeCustomerSummaries, severity, minSeverity } = req.body || {}

    const rawLimit = typeof limit === 'number' ? limit : NaN
    const max = Math.min(Math.max(Number.isNaN(rawLimit) ? 200 : rawLimit, 1), 500)

    const fromDate = parseDateOrUndefined(from)
    const toDate = parseDateOrUndefined(to)

    const filter = buildActivityFilter({
      userId,
      customer,
      from: fromDate,
      to: toDate,
      archived: false,
      severity: severity != null && severity !== '' ? String(severity) : undefined,
      minSeverity: minSeverity != null && minSeverity !== '' ? String(minSeverity) : undefined,
    })

    const activities = await Activity.find(filter)
      .sort({ createdAt: -1 })
      .limit(max)
      .populate('userId', 'name email role')
      .select({ customer: 1, summary: 1, createdAt: 1, structuredData: 1, rawConversation: 1, userId: 1, images: 1 })
      .lean()

    const report = await generateWeeklyQualityReport(activities, {
      from,
      to,
      includeCustomerSummaries: Boolean(includeCustomerSummaries),
    })

    const imageGallery = buildReportImageGallery(activities)

    let issueSeverityExact
    let issueSeverityMin
    const sevRaw = severity != null && severity !== '' ? parseInt(String(severity).trim(), 10) : NaN
    if (!Number.isNaN(sevRaw) && sevRaw >= 0 && sevRaw <= 3) issueSeverityExact = sevRaw
    const minSevRaw = minSeverity != null && minSeverity !== '' ? parseInt(String(minSeverity).trim(), 10) : NaN
    if (!Number.isNaN(minSevRaw) && minSevRaw >= 0 && minSevRaw <= 3) issueSeverityMin = minSevRaw

    const saved = await Report.create({
      createdBy: req.user._id,
      scopeRole: req.user.role,
      userId: typeof userId === 'string' && userId ? userId : undefined,
      customer: typeof customer === 'string' && customer.trim() ? customer.trim() : undefined,
      from: fromDate,
      to: toDate,
      includeCustomerSummaries: Boolean(includeCustomerSummaries),
      issueSeverityExact,
      issueSeverityMin,
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

// GET /api/reports
// Admin/Supervisor: list saved reports (own generated), paginated.
// Query: page, limit
router.get('/', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100)
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1)
    const skip = (page - 1) * limit

    const filter = { createdBy: req.user._id }

    const [reports, total] = await Promise.all([
      Report.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select({ content: 0, imageGallery: 0 }) // list view: omit large fields
        .lean(),
      Report.countDocuments(filter),
    ])

    const totalPages = Math.max(1, Math.ceil(total / limit))
    res.json({ reports, total, page, limit, totalPages })
  } catch (err) {
    next(err)
  }
})

// GET /api/reports/:id
// Admin/Supervisor: get a saved report (only if createdBy is you)
router.get('/:id', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const report = await Report.findById(req.params.id).lean()
    if (!report) return res.status(404).json({ error: 'Report not found' })
    if (String(report.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Forbidden — you cannot view this report' })
    }
    res.json({ report })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/reports/:id
// Admin/Supervisor: delete a saved report (only if createdBy is you)
router.delete('/:id', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const report = await Report.findById(req.params.id).lean()
    if (!report) return res.status(404).json({ error: 'Report not found' })
    if (String(report.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Forbidden — you cannot delete this report' })
    }
    await Report.deleteOne({ _id: req.params.id })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/reports/clear
// Admin/Supervisor: clear your report history
router.post('/clear', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await Report.deleteMany({ createdBy: req.user._id })
    res.json({ success: true, deleted: result.deletedCount || 0 })
  } catch (err) {
    next(err)
  }
})

export { router as reportsRouter }

