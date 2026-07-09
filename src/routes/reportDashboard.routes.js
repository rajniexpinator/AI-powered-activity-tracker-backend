import { Router } from 'express'
import { protectRoute as authProtect, requireRole as authRequireRole } from '../middleware/auth.js'
import { isAdminRole } from '../constants/roles.js'
import { Report } from '../models/Report.js'
import { ReportDashboard } from '../models/ReportDashboard.js'
import { generateReportFromParams, inferDateMode } from '../services/reportGeneration.js'
import { renderWeeklyReportPdf } from '../services/reportPdf.js'
import {
  mergeDuplicateFields,
  parseEmployeeReportPlan,
  sanitizeEmployeePreviewOverrides,
} from '../services/reportDashboardAccess.js'

const router = Router()

function dashboardParamsFromDoc(doc) {
  return {
    userId: doc.userId?.toString(),
    customer: doc.customer,
    from: doc.from,
    to: doc.to,
    period: doc.period,
    dateMode: doc.dateMode,
    aiQuestion: doc.aiQuestion,
    includeCustomerSummaries: doc.scopeRole === 'employee' ? false : doc.includeCustomerSummaries,
    severity: doc.issueSeverityExact,
    minSeverity: doc.issueSeverityMin,
  }
}

function mergePreviewParams(doc, body, { employeeDatesOnly = false } = {}) {
  if (employeeDatesOnly || doc.scopeRole === 'employee') {
    return sanitizeEmployeePreviewOverrides(body || {}, doc)
  }
  return {
    ...dashboardParamsFromDoc(doc),
    ...(body?.customer !== undefined ? { customer: body.customer } : {}),
    ...(body?.from !== undefined ? { from: body.from } : {}),
    ...(body?.to !== undefined ? { to: body.to } : {}),
    ...(body?.period !== undefined ? { period: body.period } : {}),
    ...(body?.dateMode !== undefined ? { dateMode: body.dateMode } : {}),
    ...(body?.aiQuestion !== undefined ? { aiQuestion: body.aiQuestion } : {}),
    ...(body?.severity !== undefined ? { severity: body.severity } : {}),
    ...(body?.minSeverity !== undefined ? { minSeverity: body.minSeverity } : {}),
  }
}

async function loadDashboardForUser(id, user, { employeeDatesOnly = false } = {}) {
  const doc = await ReportDashboard.findById(id).lean()
  if (!doc) return { error: { status: 404, message: 'Dashboard report not found' } }

    if (doc.scopeRole === 'employee') {
      if (String(doc.createdBy) !== String(user._id)) {
        return { error: { status: 403, message: 'Forbidden' } }
      }
      return { doc }
    }

    if (!isAdminRole(user.role)) {
      return { error: { status: 403, message: 'Forbidden' } }
    }
    if (String(doc.createdBy) !== String(user._id)) {
      return { error: { status: 403, message: 'Forbidden' } }
    }
    return { doc }
  }

function scopeForUser(user) {
  return user.role === 'employee' ? 'employee' : 'admin'
}

// GET /api/report-dashboard — admin: admin scope; employee: employee scope
router.get('/', authProtect, async (req, res, next) => {
  try {
    const scope = scopeForUser(req.user)
    if (scope === 'admin' && !isAdminRole(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    const filter = { createdBy: req.user._id }
    if (scope === 'admin') {
      filter.$or = [{ scopeRole: 'admin' }, { scopeRole: { $exists: false } }]
    } else {
      filter.scopeRole = 'employee'
    }
    const items = await ReportDashboard.find(filter)
      .sort({ createdAt: -1 })
      .lean()
    res.json({ items, scopeRole: scope })
  } catch (err) {
    next(err)
  }
})

// POST /api/report-dashboard — admin: save from history report
router.post('/', authProtect, authRequireRole('admin'), async (req, res, next) => {
  try {
    const { displayName, sourceReportId } = req.body || {}
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required' })
    }
    if (!sourceReportId || typeof sourceReportId !== 'string') {
      return res.status(400).json({ error: 'sourceReportId is required' })
    }

    const source = await Report.findById(sourceReportId).lean()
    if (!source) return res.status(404).json({ error: 'Source report not found' })
    if (String(source.createdBy) !== String(req.user._id)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    const name = displayName.trim()
    const existing = await ReportDashboard.findOne({
      createdBy: req.user._id,
      scopeRole: 'admin',
      displayName: name,
    }).lean()
    if (existing) {
      return res.status(409).json({ error: 'You already have a dashboard report with this name. Choose a unique name.' })
    }

    const dateMode = inferDateMode({
      aiQuestion: source.aiQuestion,
      period: source.period,
      dateMode: source.dateMode,
    })

    const saved = await ReportDashboard.create({
      createdBy: req.user._id,
      scopeRole: 'admin',
      displayName: name,
      sourceReportId: source._id,
      userId: source.userId,
      customer: source.customer,
      from: source.from,
      to: source.to,
      period: source.period,
      dateMode,
      includeCustomerSummaries: source.includeCustomerSummaries,
      issueSeverityExact: source.issueSeverityExact,
      issueSeverityMin: source.issueSeverityMin,
      aiQuestion: source.aiQuestion,
    })

    res.status(201).json({ item: saved })
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'You already have a dashboard report with this name. Choose a unique name.' })
    }
    next(err)
  }
})

// POST /api/report-dashboard/from-ai — employee (or admin testing): AI question + name
router.post('/from-ai', authProtect, async (req, res, next) => {
  try {
    const { displayName, aiQuestion } = req.body || {}
    if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required' })
    }

    if (req.user.role !== 'employee') {
      return res.status(403).json({ error: 'Simple AI reports are for employees. Admins use the Reports page.' })
    }

    const { plan, customer, aiQuestion: q } = await parseEmployeeReportPlan(aiQuestion, { displayName })
    const name = displayName.trim()

    const existing = await ReportDashboard.findOne({
      createdBy: req.user._id,
      scopeRole: 'employee',
      displayName: name,
    }).lean()
    if (existing) {
      return res.status(409).json({ error: 'You already have a report with this name. Choose a unique name.' })
    }

    const dateMode = inferDateMode({ aiQuestion: q, period: /\btoday\b/i.test(q) ? 'today' : undefined })

    const saved = await ReportDashboard.create({
      createdBy: req.user._id,
      scopeRole: 'employee',
      displayName: name,
      userId: req.user._id,
      customer,
      from: plan.from ? new Date(plan.from) : undefined,
      to: plan.to ? new Date(plan.to) : undefined,
      period: dateMode === 'today' ? 'today' : undefined,
      dateMode,
      includeCustomerSummaries: false,
      aiQuestion: q,
    })

    res.status(201).json({ item: saved })
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'You already have a report with this name. Choose a unique name.' })
    }
    if (err instanceof Error && err.message) {
      return res.status(400).json({ error: err.message })
    }
    next(err)
  }
})

router.post('/:id/preview', authProtect, async (req, res, next) => {
  try {
    const loaded = await loadDashboardForUser(req.params.id, req.user)
    if (loaded.error) return res.status(loaded.error.status).json({ error: loaded.error.message })
    const doc = loaded.doc
    const employeeDatesOnly = doc.scopeRole === 'employee'
    const params = mergePreviewParams(doc, req.body || {}, { employeeDatesOnly })

    const generated = await generateReportFromParams(params)
    res.json({
      displayName: doc.displayName,
      dateMode: inferDateMode(params),
      content: generated.content,
      imageGallery: generated.imageGallery,
      activityCount: generated.activityCount,
      customer: generated.customer || doc.customer,
    })
  } catch (err) {
    next(err)
  }
})

router.post('/:id/pdf', authProtect, async (req, res, next) => {
  try {
    const loaded = await loadDashboardForUser(req.params.id, req.user)
    if (loaded.error) return res.status(loaded.error.status).json({ error: loaded.error.message })
    const doc = loaded.doc
    const employeeDatesOnly = doc.scopeRole === 'employee'
    const params = mergePreviewParams(doc, req.body || {}, { employeeDatesOnly })

    const generated = await generateReportFromParams(params)
    const title = `${doc.displayName}${generated.customer ? ` – ${generated.customer}` : ''}`
    const pdf = await renderWeeklyReportPdf({
      title,
      content: generated.content,
      imageGallery: generated.imageGallery || [],
    })

    const safe = doc.displayName.replace(/[^\w.\-() ]+/g, '_').slice(0, 60) || 'report'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`)
    res.setHeader('Content-Length', String(pdf.length))
    res.send(pdf)
  } catch (err) {
    next(err)
  }
})

router.post('/:id/duplicate', authProtect, async (req, res, next) => {
  try {
    const loaded = await loadDashboardForUser(req.params.id, req.user)
    if (loaded.error) return res.status(loaded.error.status).json({ error: loaded.error.message })
    const source = loaded.doc

    if (source.scopeRole === 'admin' && !isAdminRole(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    let fields
    try {
      fields = mergeDuplicateFields(source, req.body || {})
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid request' })
    }

    const clash = await ReportDashboard.findOne({
      createdBy: req.user._id,
      scopeRole: source.scopeRole,
      displayName: fields.displayName,
    }).lean()
    if (clash) return res.status(409).json({ error: 'Name already in use' })

    const saved = await ReportDashboard.create({
      ...fields,
      createdBy: req.user._id,
      scopeRole: source.scopeRole,
    })
    res.status(201).json({ item: saved })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id', authProtect, async (req, res, next) => {
  try {
    const doc = await ReportDashboard.findById(req.params.id)
    if (!doc) return res.status(404).json({ error: 'Dashboard report not found' })

    if (doc.scopeRole === 'employee') {
      if (String(doc.createdBy) !== String(req.user._id)) {
        return res.status(403).json({ error: 'Forbidden' })
      }
    } else if (!isAdminRole(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' })
    }

    await ReportDashboard.deleteOne({ _id: doc._id })
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export { router as reportDashboardRouter }
