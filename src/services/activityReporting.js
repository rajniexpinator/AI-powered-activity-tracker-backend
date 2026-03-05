import { createChatCompletion } from './openai.js'

/**
 * Generate a weekly quality report from a list of activities.
 *
 * @param {Array<any>} activities - Activity documents (already filtered for the period)
 * @param {{ from?: string, to?: string }} [options]
 * @returns {Promise<string>}
 */
export async function generateWeeklyQualityReport(activities, options = {}) {
  const { from, to } = options

  if (!activities || activities.length === 0) {
    return 'No quality activities were logged in the selected period.'
  }

  const periodLabel =
    from || to
      ? `for the period ${from ? new Date(from).toLocaleDateString() : ''}${
          from && to ? ' to ' : ''
        }${to ? new Date(to).toLocaleDateString() : ''}`.trim()
      : 'for the recent period'

  const lines = activities.slice(0, 200).map((a) => {
    const user = a.userId || {}
    const structured = a.structuredData || {}
    const parts = []
    parts.push(`- When: ${new Date(a.createdAt).toISOString()}`)
    parts.push(`  Employee: ${user.name || 'Unknown'} (${user.email || 'no email'})`)
    parts.push(`  Customer: ${a.customer || structured.customer || 'Unknown'}`)
    parts.push(`  Summary: ${a.summary || structured.summary || ''}`)
    if (structured.part_name) {
      parts.push(`  Part: ${structured.part_name}`)
    }
    if (structured.intent) {
      parts.push(`  Intent: ${structured.intent}`)
    }
    if (structured.outcome) {
      parts.push(`  Outcome: ${structured.outcome}`)
    }
    if (Array.isArray(structured.next_actions) && structured.next_actions.length > 0) {
      parts.push(`  Next actions: ${structured.next_actions.join('; ')}`)
    }
    return parts.join('\n')
  })

  const system = `
You are a senior quality engineer at Apex Quality Control.
You receive a list of structured activity logs from automotive plants (mainly Ford) where Apex represents suppliers.

Write a concise weekly quality report ${periodLabel} that could be emailed to supplier engineering / plant management.

Focus on:
- Key customers and plants visited
- Top issues / concerns and their status
- Actions taken by Apex employees
- Risks and recommended follow-ups for next week

Keep the report clear and structured with short sections and bullet points.
Do NOT invent issues that are not supported by the logs.`.trim()

  const user = `
Here are the activity logs for this period:

${lines.join('\n\n')}

Write the weekly quality report now.`.trim()

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

