import { Activity } from '../models/Activity.js'
import { Customer } from '../models/Customer.js'
import { generateWeeklyQualityReport } from './activityReporting.js'
import { buildReportImageGallery } from './reportImageGallery.js'
import { interpretActivityQuestion, buildActivityFilterFromPlan } from './activityAiQuery.js'
import { buildQualityReportTitle, deriveReportOem } from './reportTitle.js'
import { normalizeReportSections } from '../constants/reportSections.js'

function escapeRegex(s) {
  return typeof s === 'string' ? s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
}

function applyOemFilter(filter, oem) {
  if (typeof oem === 'string' && oem.trim()) {
    filter.reportingPlant = oem.trim()
  }
}

function applyCustomerFilterFromParams(filter, params) {
  const names = Array.isArray(params.customers)
    ? params.customers.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
    : []
  if (names.length === 0 && typeof params.customer === 'string' && params.customer.trim()) {
    names.push(params.customer.trim())
  }
  if (names.length === 1) filter.customer = names[0]
  else if (names.length > 1) filter.customer = { $in: names }
}

function parseDateOrUndefined(value) {
  if (value == null || value === '') return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value === 'string' && value) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? undefined : d
  }
  return undefined
}

/**
 * Parse a "to" date and make it inclusive: a date-only value (or one landing on
 * exact midnight) is extended to the end of that day so logs from that day count.
 */
function parseToEndOfDay(value) {
  const d = parseDateOrUndefined(value)
  if (!d) return undefined
  const out = new Date(d)
  if (
    out.getUTCHours() === 0 &&
    out.getUTCMinutes() === 0 &&
    out.getUTCSeconds() === 0 &&
    out.getUTCMilliseconds() === 0
  ) {
    out.setUTCHours(23, 59, 59, 999)
  }
  return out
}

export function resolveTodayRange() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return { from: start, to: end }
}

export function inferDateMode({ aiQuestion, period, dateMode }) {
  if (dateMode === 'today') return 'today'
  if (typeof period === 'string' && period.trim().toLowerCase() === 'today') return 'today'
  if (typeof aiQuestion === 'string' && /\btoday\b/i.test(aiQuestion)) return 'today'
  return 'fixed'
}

function createdAtRangeFromPeriod(period) {
  const key = typeof period === 'string' ? period.trim().toLowerCase() : ''
  if (!key || key === 'all') return null
  if (key === 'today') return resolveTodayRange()
  const end = new Date()
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  switch (key) {
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

function applyStructuredSeverityFilter(filter, { severity, minSeverity }) {
  let exact = NaN
  if (severity != null && severity !== '') {
    exact = parseInt(String(severity).trim(), 10)
  }
  if (!Number.isNaN(exact) && exact >= 0 && exact <= 3) {
    filter['structuredData.severity'] = exact
    return
  }
  let minSev = NaN
  if (minSeverity != null && minSeverity !== '') {
    minSev = parseInt(String(minSeverity).trim(), 10)
  }
  if (!Number.isNaN(minSev) && minSev >= 0 && minSev <= 3) {
    filter['structuredData.severity'] = { $gte: minSev }
  }
}

export function buildActivityFilterFromReportParams(params) {
  const {
    period,
    from,
    to,
    archived = false,
    severity,
    minSeverity,
    dateMode,
    userId,
  } = params

  const filter = { isArchived: Boolean(archived) }
  if (typeof userId === 'string' && userId) filter.userId = userId
  applyCustomerFilterFromParams(filter, params)
  applyOemFilter(filter, params.oem)

  const mode = inferDateMode({ period, dateMode, aiQuestion: params.aiQuestion })
  if (mode === 'today') {
    const range = resolveTodayRange()
    filter.createdAt = { $gte: range.from, $lte: range.to }
  } else {
    const periodRange = createdAtRangeFromPeriod(period)
    const fromDate = parseDateOrUndefined(from)
    const toDate = parseToEndOfDay(to)
    if (periodRange) {
      filter.createdAt = periodRange
    } else if (fromDate || toDate) {
      const createdAt = {}
      if (fromDate) createdAt.$gte = fromDate
      if (toDate) createdAt.$lte = toDate
      if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt
    }
  }

  applyStructuredSeverityFilter(filter, { severity, minSeverity })
  return filter
}

/**
 * @param {Record<string, unknown>} params
 * @param {{ limit?: number }} [opts]
 */
export async function generateReportFromParams(params, opts = {}) {
  const rawLimit = typeof opts.limit === 'number' ? opts.limit : NaN
  const max = Math.min(Math.max(Number.isNaN(rawLimit) ? 200 : rawLimit, 1), 500)
  const reportSections = normalizeReportSections(params.reportSections)
  const includeReportPictures = params.includeReportPictures !== false
  const hideSeverity = params.hideSeverity !== false

  let activities
  let fromLabel = params.from
  let toLabel = params.to
  let customerLabel = params.customer
  if (!customerLabel && Array.isArray(params.customers) && params.customers.length === 1) {
    customerLabel = params.customers[0]
  }

  const reportOpts = {
    from: fromLabel,
    to: toLabel,
    includeCustomerSummaries: Boolean(params.includeCustomerSummaries),
    reportSections,
    hideSeverity,
  }

  const finish = (activitiesList) => {
    const oem =
      typeof params.oem === 'string' && params.oem.trim() ? params.oem.trim() : deriveReportOem(activitiesList)
    const title = buildQualityReportTitle({ customer: customerLabel, oem })
    return { oem, title, activitiesList }
  }

  if (typeof params.aiQuestion === 'string' && params.aiQuestion.trim()) {
    const custRows = await Customer.find().select('name').lean().limit(200)
    const names = custRows.map((c) => c.name).filter(Boolean)
    const plan = await interpretActivityQuestion(params.aiQuestion.trim(), names)
    const filter = buildActivityFilterFromPlan(plan)
    const mode = inferDateMode({ aiQuestion: params.aiQuestion, dateMode: params.dateMode, period: params.period })
    if (mode === 'today') {
      const range = resolveTodayRange()
      filter.createdAt = { $gte: range.from, $lte: range.to }
      fromLabel = range.from
      toLabel = range.to
    } else {
      // Manual date filters from the change/re-run screen override the AI plan's dates.
      const periodRange = createdAtRangeFromPeriod(params.period)
      const manualFrom = parseDateOrUndefined(params.from)
      const manualTo = parseToEndOfDay(params.to)
      if (periodRange) {
        filter.createdAt = periodRange
        fromLabel = periodRange.$gte
        toLabel = periodRange.$lte
      } else if (manualFrom || manualTo) {
        const createdAt = {}
        if (manualFrom) createdAt.$gte = manualFrom
        if (manualTo) createdAt.$lte = manualTo
        if (Object.keys(createdAt).length > 0) {
          filter.createdAt = createdAt
          fromLabel = manualFrom ?? fromLabel
          toLabel = manualTo ?? toLabel
        }
      }
    }
    if (typeof params.customer === 'string' && params.customer.trim()) {
      const c = params.customer.trim()
      // Match the AI plan's flexible (case-insensitive substring) customer match,
      // so re-running a saved AI report finds the same logs instead of 0.
      filter.customer = new RegExp(escapeRegex(c), 'i')
      customerLabel = c
    }
    applyOemFilter(filter, params.oem)
    applyStructuredSeverityFilter(filter, {
      severity: params.severity ?? params.issueSeverityExact,
      minSeverity: params.minSeverity ?? params.issueSeverityMin,
    })
    if (typeof params.userId === 'string' && params.userId) {
      filter.userId = params.userId
    }

    activities = await Activity.find(filter)
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
        location: 1,
        reportingPlant: 1,
      })
      .lean()

    const report = await generateWeeklyQualityReport(activities, reportOpts)
    const { oem, title } = finish(activities)
    const imageGallery = includeReportPictures ? buildReportImageGallery(activities) : []
    return {
      content: report,
      imageGallery,
      activityCount: activities.length,
      customer: customerLabel,
      from: fromLabel,
      to: toLabel,
      oem,
      title,
      reportSections,
      includeReportPictures,
      hideSeverity,
    }
  }

  const filter = buildActivityFilterFromReportParams(params)
  activities = await Activity.find(filter)
    .sort({ createdAt: -1 })
    .limit(max)
    .populate('userId', 'name email role')
    .select({
      customer: 1,
      summary: 1,
      createdAt: 1,
      structuredData: 1,
      rawConversation: 1,
      userId: 1,
      images: 1,
      location: 1,
      reportingPlant: 1,
    })
    .lean()

  const mode = inferDateMode(params)
  if (mode === 'today') {
    const range = resolveTodayRange()
    fromLabel = range.from
    toLabel = range.to
  }

  const report = await generateWeeklyQualityReport(activities, reportOpts)
  const { oem, title } = finish(activities)
  const imageGallery = includeReportPictures ? buildReportImageGallery(activities) : []

  return {
    content: report,
    imageGallery,
    activityCount: activities.length,
    customer: customerLabel,
    from: fromLabel,
    to: toLabel,
    oem,
    title,
    reportSections,
    includeReportPictures,
    hideSeverity,
  }
}
