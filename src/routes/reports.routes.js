import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { Activity } from '../models/Activity.js'
import { Report } from '../models/Report.js'
import { generateWeeklyQualityReport } from '../services/activityReporting.js'
import { buildReportImageGallery } from '../services/reportImageGallery.js'
import { renderWeeklyReportPdf } from '../services/reportPdf.js'
import { generateReportFromParams, inferDateMode } from '../services/reportGeneration.js'

const router = Router()

function buildReportPdfTitle(report) {
  const titleParts = ['Weekly quality report']
  if (report?.from || report?.to) {
    const fromLabel = report.from ? new Date(report.from).toLocaleDateString() : ''
    const toLabel = report.to ? new Date(report.to).toLocaleDateString() : ''
    const range = `${fromLabel}${fromLabel && toLabel ? ' to ' : ''}${toLabel}`.trim()
    if (range) titleParts.push(range)
  }
  if (report?.customer) titleParts.push(String(report.customer))
  return titleParts.join(' – ')
}

function safePdfFilename(report) {
  const customer = typeof report?.customer === 'string' && report.customer.trim() ? report.customer.trim() : 'report'
  const safe = customer.replace(/[^\w.\-() ]+/g, '_').slice(0, 60) || 'report'
  const date = report?.createdAt ? new Date(report.createdAt).toISOString().slice(0, 10) : 'export'
  return `weekly-report-${safe}-${date}.pdf`
}

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

function parseCustomersInput(body) {
  if (!body || typeof body !== 'object') return []
  const names = new Set()
  const raw = body.customers
  if (Array.isArray(raw)) {
    for (const part of raw) {
      if (typeof part === 'string' && part.trim()) names.add(part.trim())
    }
  } else if (typeof raw === 'string' && raw.trim()) {
    for (const part of raw.split(',')) {
      const t = part.trim()
      if (t) names.add(t)
    }
  }
  if (typeof body.customer === 'string' && body.customer.trim()) names.add(body.customer.trim())
  return [...names]
}

function createdAtRangeFromPeriod(period) {
  const key = typeof period === 'string' ? period.trim().toLowerCase() : ''
  if (!key || key === 'all') return null
  const end = new Date()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  switch (key) {
    case 'today':
      break
    case '3days':
      start.setDate(start.getDate() - 2)
      break
    case 'week':
      start.setDate(start.getDate() - 6)
      break
    case '2weeks':
      start.setDate(start.getDate() - 13)
      break
    case 'month':
      start.setMonth(start.getMonth() - 1)
      break
    default:
      return null
  }
  return { $gte: start, $lte: end }
}

function buildActivityFilter({ userId, customer, customers, period, from, to, archived, severity, minSeverity }) {
  const filter = { isArchived: Boolean(archived) }
  if (typeof userId === 'string' && userId) filter.userId = userId
  const customerNames = customers?.length ? customers : customer ? [customer] : []
  if (customerNames.length === 1) filter.customer = customerNames[0]
  else if (customerNames.length > 1) filter.customer = { $in: customerNames }
  const periodRange = createdAtRangeFromPeriod(period)
  if (periodRange) {
    filter.createdAt = periodRange
  } else if (from || to) {
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
    const body = req.body || {}
    const { userId, customer, from, to, limit, includeCustomerSummaries, severity, minSeverity, period } = body
    const customers = parseCustomersInput(body)

    const rawLimit = typeof limit === 'number' ? limit : NaN
    const max = Math.min(Math.max(Number.isNaN(rawLimit) ? 200 : rawLimit, 1), 500)

    const fromDate = parseDateOrUndefined(from)
    const toDate = parseDateOrUndefined(to)
    const useCustomDates = Boolean(fromDate || toDate)

    const filter = buildActivityFilter({
      userId,
      customer,
      customers,
      period: !useCustomDates && typeof period === 'string' ? period : undefined,
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
      .select({ customer: 1, summary: 1, createdAt: 1, structuredData: 1, rawConversation: 1, userId: 1, images: 1, location: 1 })
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

    const dateMode = inferDateMode({
      period: !useCustomDates && typeof period === 'string' ? period : undefined,
      aiQuestion: typeof body.aiQuestion === 'string' ? body.aiQuestion : undefined,
      dateMode: typeof body.dateMode === 'string' ? body.dateMode : undefined,
    })

    const saved = await Report.create({
      createdBy: req.user._id,
      scopeRole: req.user.role,
      userId: typeof userId === 'string' && userId ? userId : undefined,
      customer: typeof customer === 'string' && customer.trim() ? customer.trim() : undefined,
      from: fromDate,
      to: toDate,
      period: !useCustomDates && typeof period === 'string' ? period.trim() : undefined,
      dateMode,
      aiQuestion: typeof body.aiQuestion === 'string' && body.aiQuestion.trim() ? body.aiQuestion.trim() : undefined,
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

// POST /api/reports/:id/regenerate — update filters and re-run AI narrative
router.post('/:id/regenerate', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await Report.findById(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Report not found' })
    if (String(existing.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Forbidden — you cannot edit this report' })
    }

    const body = req.body || {}
    const params = {
      userId: body.userId !== undefined ? body.userId : existing.userId?.toString(),
      customer: body.customer !== undefined ? body.customer : existing.customer,
      from: body.from !== undefined ? body.from : existing.from,
      to: body.to !== undefined ? body.to : existing.to,
      period: body.period !== undefined ? body.period : existing.period,
      dateMode: body.dateMode !== undefined ? body.dateMode : existing.dateMode,
      aiQuestion: body.aiQuestion !== undefined ? body.aiQuestion : existing.aiQuestion,
      includeCustomerSummaries:
        body.includeCustomerSummaries !== undefined
          ? body.includeCustomerSummaries
          : existing.includeCustomerSummaries,
      severity:
        body.severity !== undefined
          ? body.severity
          : existing.issueSeverityExact != null
            ? existing.issueSeverityExact
            : undefined,
      minSeverity:
        body.minSeverity !== undefined
          ? body.minSeverity
          : existing.issueSeverityMin != null
            ? existing.issueSeverityMin
            : undefined,
      limit: body.limit,
    }

    const generated = await generateReportFromParams(params)

    let issueSeverityExact = existing.issueSeverityExact
    let issueSeverityMin = existing.issueSeverityMin
    const sevRaw = body.severity != null && body.severity !== '' ? parseInt(String(body.severity).trim(), 10) : NaN
    if (!Number.isNaN(sevRaw) && sevRaw >= 0 && sevRaw <= 3) {
      issueSeverityExact = sevRaw
      issueSeverityMin = undefined
    } else if (body.minSeverity != null && body.minSeverity !== '') {
      const minSevRaw = parseInt(String(body.minSeverity).trim(), 10)
      if (!Number.isNaN(minSevRaw) && minSevRaw >= 0 && minSevRaw <= 3) {
        issueSeverityMin = minSevRaw
        issueSeverityExact = undefined
      }
    }

    existing.customer = typeof params.customer === 'string' && params.customer.trim() ? params.customer.trim() : undefined
    existing.from = generated.from ? new Date(generated.from) : parseDateOrUndefined(params.from)
    existing.to = generated.to ? new Date(generated.to) : parseDateOrUndefined(params.to)
    existing.period = typeof params.period === 'string' ? params.period : undefined
    existing.dateMode = inferDateMode({
      period: params.period,
      dateMode: params.dateMode,
      aiQuestion: params.aiQuestion,
    })
    existing.aiQuestion = typeof params.aiQuestion === 'string' && params.aiQuestion.trim() ? params.aiQuestion.trim() : undefined
    existing.includeCustomerSummaries = Boolean(params.includeCustomerSummaries)
    existing.issueSeverityExact = issueSeverityExact
    existing.issueSeverityMin = issueSeverityMin
    existing.content = generated.content
    existing.activityCount = generated.activityCount
    existing.imageGallery = generated.imageGallery?.length ? generated.imageGallery : undefined
    await existing.save()

    res.json({
      report: existing.content,
      reportId: existing._id,
      imageGallery: existing.imageGallery,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/reports/:id/pdf
router.get('/:id/pdf', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const report = await Report.findById(req.params.id).lean()
    if (!report) return res.status(404).json({ error: 'Report not found' })
    if (String(report.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Forbidden — you cannot view this report' })
    }

    const title = buildReportPdfTitle(report)
    const pdf = await renderWeeklyReportPdf({
      title,
      content: report.content,
      imageGallery: Array.isArray(report.imageGallery) ? report.imageGallery : [],
    })

    const filename = safePdfFilename(report)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(pdf.length))
    res.send(pdf)
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

