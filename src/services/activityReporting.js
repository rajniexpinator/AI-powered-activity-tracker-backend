import { createChatCompletion } from './openai.js'
import { BarcodeMapping } from '../models/BarcodeMapping.js'
import { enabledSectionPromptLines, normalizeReportSections } from '../constants/reportSections.js'
import { formatUsDate } from '../utils/formatDate.js'

/** Remove any line that mentions severity (used when hideSeverity is on). */
function stripSeverityMentions(text) {
  if (typeof text !== 'string' || !text) return text
  return text
    .split('\n')
    .filter((line) => !/severity/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Map a report heading line to one of the known section keys, or null if unknown. */
function classifySectionHeading(headingText) {
  const t = String(headingText || '').toLowerCase()
  if (/customer/.test(t) && /(visit|plant)/.test(t)) return 'customersVisited'
  if (/summary/.test(t)) return 'visitSummary'
  if (/action/.test(t)) return 'keyActions'
  if (/(risk|follow[\s-]*up|recommend)/.test(t)) return 'risks'
  if (/(next step|closing)/.test(t)) return 'nextSteps'
  return null
}

/**
 * Hard safety net: remove any numbered section the user disabled, even if the AI
 * included it anyway. Sections we can't confidently classify are left untouched.
 * Kept sections are renumbered sequentially.
 */
function filterDisabledSections(text, reportSections) {
  if (typeof text !== 'string' || !text) return text
  const sections = normalizeReportSections(reportSections)
  const lines = text.split('\n')
  const headingRe = /^\s*(\d+)[.)]\s+\S/

  const headingIdx = []
  lines.forEach((line, i) => {
    if (headingRe.test(line)) headingIdx.push(i)
  })
  if (headingIdx.length === 0) return text

  const preamble = lines.slice(0, headingIdx[0])
  const kept = []
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h]
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length
    const block = lines.slice(start, end)
    const key = classifySectionHeading(block[0])
    if (key && sections[key] === false) continue // user turned this section off
    kept.push(block)
  }

  let counter = 0
  const renumbered = kept.flatMap((block) => {
    counter += 1
    const [head, ...rest] = block
    const newHead = head.replace(headingRe, (m) => m.replace(/\d+/, String(counter)))
    return [newHead, ...rest]
  })

  return [...preamble, ...renumbered]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Generate a quality report narrative from a list of activities.
 *
 * @param {Array<any>} activities - Activity documents (already filtered for the period)
 * @param {{ from?: string, to?: string, includeCustomerSummaries?: boolean, reportSections?: object }} [options]
 * @returns {Promise<string>}
 */
export async function generateWeeklyQualityReport(activities, options = {}) {
  const { from, to, includeCustomerSummaries } = options
  const hideSeverity = options.hideSeverity !== false
  const reportSections = normalizeReportSections(options.reportSections)
  const sectionLines = enabledSectionPromptLines(reportSections)

  if (sectionLines.length === 0) {
    return 'No report sections were selected.'
  }

  if (!activities || activities.length === 0) {
    return 'No quality activities were logged in the selected period.'
  }

  const extractBarcodes = (raw) => {
    if (!raw || typeof raw !== 'string') return []
    const matches = []
    const re = /scanned barcode:\s*([a-z0-9\-_./]+)/gi
    let m
    while ((m = re.exec(raw)) !== null) {
      const code = String(m[1] || '').trim()
      if (code) matches.push(code)
    }
    return matches
  }

  const periodLabel =
    from || to
      ? `for the period ${from ? formatUsDate(from) : ''}${from && to ? ' to ' : ''}${
          to ? formatUsDate(to) : ''
        }`.trim()
      : 'for the recent period'

  const normalized = activities.slice(0, 250).map((a) => {
    const user = a.userId || {}
    const structured = a.structuredData || {}
    const customer = a.customer || structured.customer || 'Unknown'
    const barcodes = extractBarcodes(a.rawConversation)
    return {
      createdAt: a.createdAt,
      customer,
      employeeName: user.name || 'Unknown',
      employeeEmail: user.email || 'no email',
      summary: a.summary || structured.summary || '',
      part: structured.part_name,
      intent: structured.intent,
      outcome: structured.outcome,
      nextActions: Array.isArray(structured.next_actions) ? structured.next_actions : [],
      barcodes,
    }
  })

  const uniqueBarcodes = Array.from(
    new Set(normalized.flatMap((a) => (Array.isArray(a.barcodes) ? a.barcodes : [])))
  ).slice(0, 50)

  let barcodeNotesBlock = ''
  if (uniqueBarcodes.length > 0) {
    const mappings = await BarcodeMapping.find({ barcode: { $in: uniqueBarcodes } })
      .select({ barcode: 1, productName: 1, customer: 1, metadata: 1, updatedAt: 1 })
      .lean()

    const byCode = new Map(mappings.map((m) => [String(m.barcode), m]))
    const lines = uniqueBarcodes.map((code) => {
      const m = byCode.get(code)
      if (!m) return `- ${code}: (no mapping found in database)`
      const notes =
        m.metadata && typeof m.metadata === 'object' && typeof m.metadata.notes === 'string'
          ? m.metadata.notes.trim()
          : ''
      const label = `${m.productName ? m.productName : ''}${m.customer ? ` (${m.customer})` : ''}`.trim()
      return `- ${code}${label ? `: ${label}` : ''}${notes ? ` — Notes: ${notes}` : ''}`
    })
    barcodeNotesBlock = lines.join('\n')
  }

  const buildEntryLines = (a) => {
    const parts = []
    parts.push(`- When: ${formatUsDate(a.createdAt)}`)
    parts.push(`  Employee: ${a.employeeName} (${a.employeeEmail})`)
    parts.push(`  Customer: ${a.customer}`)
    parts.push(`  Summary: ${a.summary}`)
    if (a.part) parts.push(`  Part: ${a.part}`)
    if (Array.isArray(a.barcodes) && a.barcodes.length > 0) {
      parts.push(`  Barcodes scanned: ${a.barcodes.slice(0, 6).join(', ')}`)
    }
    if (a.intent) parts.push(`  Intent: ${a.intent}`)
    if (a.outcome) parts.push(`  Outcome: ${a.outcome}`)
    if (Array.isArray(a.nextActions) && a.nextActions.length > 0) {
      parts.push(`  Next actions: ${a.nextActions.join('; ')}`)
    }
    return parts.join('\n')
  }

  let logsBlock = ''
  if (includeCustomerSummaries) {
    const byCustomer = new Map()
    for (const a of normalized) {
      const key = a.customer || 'Unknown'
      if (!byCustomer.has(key)) byCustomer.set(key, [])
      byCustomer.get(key).push(a)
    }
    const chunks = Array.from(byCustomer.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 50)
      .map(([customer, items]) => {
        const lines = items.slice(0, 80).map(buildEntryLines)
        return [`## Customer: ${customer}`, lines.join('\n\n')].join('\n')
      })
    logsBlock = chunks.join('\n\n')
  } else {
    logsBlock = normalized.slice(0, 200).map(buildEntryLines).join('\n\n')
  }

  const system = `
You are a senior quality engineer at Apex Quality Control.
You receive a list of structured activity logs from automotive plants (mainly Ford) where Apex represents suppliers.

Write a professional quality report ${periodLabel} that can be sent directly to supplier engineering / plant management.

Formatting rules (very important):
- Do NOT use markdown characters like *, **, ###, or ---.
- Do NOT use the word "weekly" or "Weekly Quality Report" anywhere.
- Use normal headings with numbers. Include ONLY these sections (skip any not listed):
${sectionLines.join('\n')}
- Use short paragraphs and simple hyphen bullets (e.g. "- Issue: ..."), with blank lines between sections.
- Keep the tone concise, clear, and businesslike.
${hideSeverity ? '- Do NOT mention issue severity, severity levels, or severity numbers anywhere in the report output.' : ''}

Only describe items that are supported by the logs. Do not invent new issues or customers.`.trim()

  const user = `
Here are the activity logs for this period${includeCustomerSummaries ? ' (grouped by customer)' : ''}:

${logsBlock}

${barcodeNotesBlock ? `\nBarcode mappings and notes referenced during this period:\n\n${barcodeNotesBlock}\n` : ''}

Using ONLY the information above, write a clean quality report.

- Start with a title line: "Quality Report for [Customer] at [OEM/plant]" when customer and plant are known, otherwise "Quality Report" with the period.
- Include ONLY these numbered sections (omit any not listed):
${sectionLines.join('\n')}

Remember:
- No markdown syntax.
- Do NOT use the word "weekly".
${hideSeverity ? '- Do NOT mention issue severity or severity levels.' : ''}
- Simple numbered headings and bullet points.
- Short, readable paragraphs suitable for pasting into an email or Word document.`.trim()

  const completion = await createChatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      model: 'gpt-4o-mini',
      temperature: 0.4,
    }
  )

  const content = completion.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('OpenAI returned an empty response for quality report')
  }

  let finalText = filterDisabledSections(content, reportSections)
  if (hideSeverity) finalText = stripSeverityMentions(finalText)
  return finalText
}

