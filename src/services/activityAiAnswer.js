import { createChatCompletion, getAssistantContent, isOpenAIAvailable } from './openai.js'

function asText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function extractActivityBits(a) {
  const structured = a?.structuredData && typeof a.structuredData === 'object' ? a.structuredData : {}
  const rawSev = structured.severity
  const n = typeof rawSev === 'number' ? rawSev : typeof rawSev === 'string' ? parseInt(rawSev, 10) : NaN
  const severity = n === 1 || n === 2 || n === 3 ? n : null
  return {
    customer: asText(a.customer) || asText(structured.customer) || 'Unknown',
    createdAt: a?.createdAt ? String(a.createdAt) : '',
    employee: a?.userId?.name ? String(a.userId.name) : a?.userId?.email ? String(a.userId.email) : 'Unknown',
    summary: asText(a.summary) || asText(structured.summary) || '',
    issue: asText(structured.issue) || asText(structured.problem) || asText(structured.concern) || '',
    resolution: asText(structured.resolution) || asText(structured.outcome) || asText(structured.action_taken) || '',
    nextActions: Array.isArray(structured.next_actions) ? structured.next_actions.map(asText).filter(Boolean) : [],
    part: asText(structured.part_name) || asText(structured.part) || '',
    intent: asText(structured.intent) || '',
    severity,
  }
}

/**
 * Generate a short AI narrative answer for an admin question (not a weekly report).
 * We intentionally keep the formatting simple (no markdown).
 */
export async function generateActivityAnswer(question, interpretation, plan, activities) {
  if (!isOpenAIAvailable()) {
    return 'AI is not configured on the server. Showing matched log rows only.'
  }

  const safeActivities = Array.isArray(activities) ? activities.slice(0, 15) : []
  const payload = safeActivities.map(extractActivityBits)

  const from = plan?.from ? String(plan.from) : ''
  const to = plan?.to ? String(plan.to) : ''

  const system = `
You are a quality reporting assistant for an internal activity tracker.

The user asked a question about real logged activities.
Return a helpful narrative answer using ONLY the information present in the logs below.

Formatting rules:
- Do NOT use markdown characters like *, **, ###, or ---.
- Use plain numbered sections and hyphen bullets.
- Keep it concise: 6-14 lines total.
- Do not invent customers, issues, or dates not present in the logs.
`.trim()

  const user = `
User question:
${question}

Model interpretation:
${interpretation || ''}

Time range (if inferred, else empty):
from=${from}
to=${to}

Matched log entries (up to 15):
${payload
  .map((a, i) => {
    const parts = []
    parts.push(`${i + 1}) Customer: ${a.customer}`)
    if (a.createdAt) parts.push(`   Date: ${a.createdAt}`)
    parts.push(`   Summary: ${a.summary}`)
    if (a.part) parts.push(`   Part: ${a.part}`)
    if (a.issue) parts.push(`   Issue: ${a.issue}`)
    if (a.resolution) parts.push(`   Resolution/Outcome: ${a.resolution}`)
    if (a.nextActions?.length) parts.push(`   Next actions: ${a.nextActions.join('; ')}`)
    if (a.intent) parts.push(`   Intent: ${a.intent}`)
    if (a.severity != null) parts.push(`   Issue severity: ${a.severity}`)
    return parts.join('\n')
  })
  .join('\n\n')}

Now write the final answer in the format:
1. Match summary (what the question asked and how many matches)
2. Main themes/issues (bullets)
3. Actions taken / next steps (bullets)
4. Short closing line
`.trim()

  const completion = await createChatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { model: 'gpt-4o-mini', temperature: 0.2 }
  )

  const content = getAssistantContent(completion)
  return asText(content) || 'No answer generated.'
}

