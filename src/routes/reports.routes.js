import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { Report } from '../models/Report.js'
import { buildQualityReportTitle, safeQualityReportFilename } from '../services/reportTitle.js'
import { renderWeeklyReportPdf } from '../services/reportPdf.js'
import { generateReportFromParams, inferDateMode } from '../services/reportGeneration.js'
import { resolveSharePreferences } from '../constants/sharePreferences.js'

const router = Router()

function buildReportPdfTitle(report) {
  return buildQualityReportTitle({
    customer: report?.customer,
    oem: report?.oem,
    title: report?.title,
  })
}

function safePdfFilename(report) {
  return safeQualityReportFilename(report)
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
    const customers = parseCustomersInput(body)
    const rawLimit = typeof body.limit === 'number' ? body.limit : NaN
    const max = Math.min(Math.max(Number.isNaN(rawLimit) ? 200 : rawLimit, 1), 500)

    const fromDate = parseDateOrUndefined(body.from)
    const toDate = parseDateOrUndefined(body.to)
    const useCustomDates = Boolean(fromDate || toDate)

    const params = {
      userId: typeof body.userId === 'string' && body.userId ? body.userId : undefined,
      customer: customers.length === 1 ? customers[0] : typeof body.customer === 'string' ? body.customer : undefined,
      customers: customers.length > 1 ? customers : undefined,
      period: !useCustomDates && typeof body.period === 'string' ? body.period : undefined,
      from: fromDate,
      to: toDate,
      severity: body.severity != null && body.severity !== '' ? String(body.severity) : undefined,
      minSeverity: body.minSeverity != null && body.minSeverity !== '' ? String(body.minSeverity) : undefined,
      oem: typeof body.oem === 'string' && body.oem.trim() ? body.oem.trim() : undefined,
      includeCustomerSummaries: Boolean(body.includeCustomerSummaries),
      reportSections: body.reportSections,
      includeReportPictures: body.includeReportPictures !== false,
      hideSeverity: body.hideSeverity !== false,
      aiQuestion: typeof body.aiQuestion === 'string' ? body.aiQuestion : undefined,
      dateMode: typeof body.dateMode === 'string' ? body.dateMode : undefined,
    }

    const generated = await generateReportFromParams(params, { limit: max })

    let issueSeverityExact
    let issueSeverityMin
    const sevRaw = body.severity != null && body.severity !== '' ? parseInt(String(body.severity).trim(), 10) : NaN
    if (!Number.isNaN(sevRaw) && sevRaw >= 0 && sevRaw <= 3) issueSeverityExact = sevRaw
    const minSevRaw = body.minSeverity != null && body.minSeverity !== '' ? parseInt(String(body.minSeverity).trim(), 10) : NaN
    if (!Number.isNaN(minSevRaw) && minSevRaw >= 0 && minSevRaw <= 3) issueSeverityMin = minSevRaw

    const dateMode = inferDateMode({
      period: params.period,
      aiQuestion: params.aiQuestion,
      dateMode: params.dateMode,
    })

    const saved = await Report.create({
      createdBy: req.user._id,
      scopeRole: req.user.role,
      userId: params.userId,
      customer: params.customer,
      from: fromDate,
      to: toDate,
      period: params.period?.trim?.() || params.period,
      dateMode,
      aiQuestion: params.aiQuestion?.trim?.() || undefined,
      includeCustomerSummaries: Boolean(params.includeCustomerSummaries),
      reportSections: generated.reportSections,
      includeReportPictures: generated.includeReportPictures,
      hideSeverity: generated.hideSeverity,
      issueSeverityExact,
      issueSeverityMin,
      oem: generated.oem,
      title: generated.title,
      content: generated.content,
      model: 'gpt-4o-mini',
      activityCount: generated.activityCount,
      imageGallery: generated.imageGallery?.length ? generated.imageGallery : undefined,
    })

    res.json({ report: generated.content, reportId: saved._id, imageGallery: generated.imageGallery })
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
    if (typeof req.query.oem === 'string' && req.query.oem.trim()) {
      filter.oem = req.query.oem.trim()
    }

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
      reportSections: body.reportSections !== undefined ? body.reportSections : existing.reportSections,
      includeReportPictures:
        body.includeReportPictures !== undefined
          ? body.includeReportPictures
          : existing.includeReportPictures,
      hideSeverity:
        body.hideSeverity !== undefined ? body.hideSeverity : existing.hideSeverity,
      // NOTE: existing.oem is an auto-derived title label (from each log's
      // structuredData.oem), not a saved plant filter. Re-applying it as a hard
      // reportingPlant filter on re-run wrongly drops every log (0 logs), so only
      // filter by OEM when the re-run request explicitly provides one.
      oem: typeof body.oem === 'string' && body.oem.trim() ? body.oem.trim() : undefined,
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
    existing.reportSections = generated.reportSections
    existing.includeReportPictures = generated.includeReportPictures
    existing.hideSeverity = generated.hideSeverity
    existing.issueSeverityExact = issueSeverityExact
    existing.issueSeverityMin = issueSeverityMin
    existing.content = generated.content
    existing.activityCount = generated.activityCount
    existing.oem = generated.oem
    existing.title = generated.title
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
    const prefs = resolveSharePreferences(req.user)
    const includePictures =
      report.includeReportPictures !== false &&
      prefs.report.includePictures &&
      Array.isArray(report.imageGallery)
    const pdf = await renderWeeklyReportPdf({
      title,
      content: report.content,
      imageGallery: includePictures ? report.imageGallery : [],
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

