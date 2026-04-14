import { createChatCompletion } from './openai.js'
import { BarcodeMapping } from '../models/BarcodeMapping.js'

/**
 * Generate a weekly quality report from a list of activities.
 *
 * @param {Array<any>} activities - Activity documents (already filtered for the period)
 * @param {{ from?: string, to?: string, includeCustomerSummaries?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function generateWeeklyQualityReport(activities, options = {}) {
  const { from, to, includeCustomerSummaries } = options

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
      ? `for the period ${from ? new Date(from).toLocaleDateString() : ''}${
          from && to ? ' to ' : ''
        }${to ? new Date(to).toLocaleDateString() : ''}`.trim()
      : 'for the recent period'

  const normalized = activities.slice(0, 250).map((a) => {
    const user = a.userId || {}
    const structured = a.structuredData || {}
    const customer = a.customer || structured.customer || 'Unknown'
    const barcodes = extractBarcodes(a.rawConversation)
    const rawSev = structured.severity
    const sevNum = typeof rawSev === 'number' ? rawSev : typeof rawSev === 'string' ? parseInt(rawSev, 10) : NaN
    const severity = sevNum === 1 || sevNum === 2 || sevNum === 3 ? sevNum : null
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
      severity,
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
    parts.push(`- When: ${new Date(a.createdAt).toISOString()}`)
    parts.push(`  Employee: ${a.employeeName} (${a.employeeEmail})`)
    parts.push(`  Customer: ${a.customer}`)
    parts.push(`  Summary: ${a.summary}`)
    if (a.part) parts.push(`  Part: ${a.part}`)
    if (a.severity != null) {
      const label = a.severity === 1 ? 'low' : a.severity === 2 ? 'medium' : a.severity === 3 ? 'high' : ''
      parts.push(`  Issue severity: ${a.severity}${label ? ` (${label})` : ''}`)
    }
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

Write a professional weekly quality report ${periodLabel} that can be sent directly to supplier engineering / plant management.

Formatting rules (very important):
- Do NOT use markdown characters like *, **, ###, or ---.
- Use normal headings with numbers, for example:
  Weekly Quality Report – 09/03/2026 to 16/03/2026
  1. Customers and Plants Visited
  2. Summary of Visits and Issues
  3. Key Actions Taken
  4. Risks and Recommended Follow-Ups
  5. Next Steps / Closing
- Use short paragraphs and simple hyphen bullets (e.g. "- Issue: ..."), with blank lines between sections.
- Keep the tone concise, clear, and businesslike.

Only describe items that are supported by the logs. Do not invent new issues or customers.`.trim()

  const user = `
Here are the activity logs for this period${includeCustomerSummaries ? ' (grouped by customer)' : ''}:

${logsBlock}

${barcodeNotesBlock ? `\nBarcode mappings and notes referenced during this period:\n\n${barcodeNotesBlock}\n` : ''}

Using ONLY the information above, write a clean weekly quality report in the following structure:

- Title line with "Weekly Quality Report" and the period.
- Section 1: Customers and Plants Visited (list main customers/plants and dates).
- Section 2: Summary of Visits and Issues (grouped by customer when possible).
- Section 3: Key Actions Taken.
- Section 4: Risks and Recommended Follow-Ups.
- Section 5: Next Steps / Closing sentence.

Remember:
- No markdown syntax.
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
    throw new Error('OpenAI returned an empty response for weekly report')
  }

  return content
}

