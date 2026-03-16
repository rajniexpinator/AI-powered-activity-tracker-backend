import { createChatCompletion } from './openai.js'

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
    }
  })

  const buildEntryLines = (a) => {
    const parts = []
    parts.push(`- When: ${new Date(a.createdAt).toISOString()}`)
    parts.push(`  Employee: ${a.employeeName} (${a.employeeEmail})`)
    parts.push(`  Customer: ${a.customer}`)
    parts.push(`  Summary: ${a.summary}`)
    if (a.part) parts.push(`  Part: ${a.part}`)
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

