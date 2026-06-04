import { Customer } from '../models/Customer.js'
import { interpretActivityQuestion } from './activityAiQuery.js'

/** Match a known customer name inside free text (question or report title). */
export function matchCustomerInText(text, knownNames) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw || !knownNames?.length) return null

  const lower = raw.toLowerCase()
  const sorted = [...knownNames].filter(Boolean).sort((a, b) => b.length - a.length)

  for (const name of sorted) {
    if (lower.includes(name.toLowerCase())) return name
  }

  const words = lower.split(/[\s,./\-–—]+/).filter((w) => w.length >= 3)
  for (const word of words) {
    for (const name of sorted) {
      const nameLower = name.toLowerCase()
      const firstToken = nameLower.split(/\s+/)[0]
      if (nameLower.includes(word) || (firstToken.length >= 3 && word.includes(firstToken))) {
        return name
      }
    }
  }

  return null
}

export function validateEmployeeReportQuestion(aiQuestion) {
  const q = typeof aiQuestion === 'string' ? aiQuestion.trim() : ''
  if (!q) {
    throw new Error('Please describe the report you want (e.g. "Inoac issues from today").')
  }
  if (/\ball customers\b|\ball employees\b|\bevery company\b|\bcompany.?wide\b|\bglobal\b|\beveryone'?s\b/i.test(q)) {
    throw new Error('Simple reports must be for one customer (e.g. "Inoac issues from today").')
  }
  return q
}

export async function parseEmployeeReportPlan(aiQuestion, options = {}) {
  const q = validateEmployeeReportQuestion(aiQuestion)
  const displayName = typeof options.displayName === 'string' ? options.displayName.trim() : ''

  const custRows = await Customer.find().select('name').lean().limit(200)
  const names = custRows.map((c) => c.name).filter(Boolean)

  let customer = null
  let plan = { from: null, to: null, customerSubstring: null }

  if (names.length === 0) {
    throw new Error('No customers are set up yet. Ask an admin to add customers first.')
  }

  try {
    plan = await interpretActivityQuestion(q, names)
    customer =
      typeof plan.customerSubstring === 'string' && plan.customerSubstring.trim()
        ? plan.customerSubstring.trim()
        : null
  } catch {
    /* fall back to text matching below */
  }

  if (!customer) {
    customer = matchCustomerInText(q, names) || (displayName ? matchCustomerInText(displayName, names) : null)
  }

  if (!customer) {
    const sample = names.slice(0, 6).join(', ')
    throw new Error(
      `Include a customer name that matches your list (e.g. "Inoac issues from today"). Known customers: ${sample}${names.length > 6 ? '…' : ''}.`
    )
  }

  // Prefer the canonical name from the Customers table when we matched loosely
  const canonical = names.find((n) => n.toLowerCase() === customer.toLowerCase()) || customer
  plan.customerSubstring = canonical

  return { plan, customer: canonical, aiQuestion: q }
}

/** Strip admin-only filter fields for employee preview overrides */
export function sanitizeEmployeePreviewOverrides(body, baseDoc) {
  const allowed = {}
  if (body.from !== undefined) allowed.from = body.from
  if (body.to !== undefined) allowed.to = body.to
  if (body.period !== undefined) allowed.period = body.period
  if (body.dateMode !== undefined) allowed.dateMode = body.dateMode === 'today' ? 'today' : 'fixed'
  return {
    userId: baseDoc.userId?.toString(),
    customer: baseDoc.customer,
    aiQuestion: baseDoc.aiQuestion,
    includeCustomerSummaries: false,
    severity: baseDoc.issueSeverityExact,
    minSeverity: baseDoc.issueSeverityMin,
    ...allowed,
  }
}

export function mergeDuplicateFields(source, body) {
  const name = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  if (!name) throw new Error('displayName is required')

  const next = {
    displayName: name,
    customer: source.customer,
    from: source.from,
    to: source.to,
    period: source.period,
    dateMode: source.dateMode,
    aiQuestion: source.aiQuestion,
    includeCustomerSummaries: source.includeCustomerSummaries,
    issueSeverityExact: source.issueSeverityExact,
    issueSeverityMin: source.issueSeverityMin,
    userId: source.userId,
    scopeRole: source.scopeRole,
    sourceReportId: source.sourceReportId,
  }

  if (body.customer !== undefined) next.customer = body.customer || undefined
  if (body.from !== undefined) next.from = body.from ? new Date(body.from) : undefined
  if (body.to !== undefined) next.to = body.to ? new Date(body.to) : undefined
  if (body.period !== undefined) next.period = body.period || undefined
  if (body.dateMode !== undefined) next.dateMode = body.dateMode === 'today' ? 'today' : 'fixed'
  if (body.aiQuestion !== undefined) next.aiQuestion = body.aiQuestion || undefined
  if (body.severity !== undefined && body.severity !== '') {
    const n = parseInt(String(body.severity), 10)
    if (!Number.isNaN(n)) {
      next.issueSeverityExact = n
      next.issueSeverityMin = undefined
    }
  }
  if (body.minSeverity !== undefined && body.minSeverity !== '') {
    const n = parseInt(String(body.minSeverity), 10)
    if (!Number.isNaN(n)) {
      next.issueSeverityMin = n
      next.issueSeverityExact = undefined
    }
  }

  return next
}
