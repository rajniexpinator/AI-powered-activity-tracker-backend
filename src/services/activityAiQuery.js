import { createChatCompletion, getAssistantContent, isOpenAIAvailable } from './openai.js'

function escapeRegex(s) {
  if (!s || typeof s !== 'string') return ''
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Use OpenAI to turn a natural-language question into a structured query plan (JSON).
 *
 * @param {string} question
 * @param {string[]} knownCustomerNames
 */
export async function interpretActivityQuestion(question, knownCustomerNames = []) {
  if (!isOpenAIAvailable()) {
    throw new Error('OpenAI is not configured: set OPENAI_API_KEY in the environment')
  }

  const today = new Date()
  const todayUtc = today.toISOString().slice(0, 10)
  const customers = knownCustomerNames
    .filter(Boolean)
    .slice(0, 100)
    .join('; ')

  const system = `You are a query planner for an internal activity database (quality visits, supplier issues, plant notes).

Return ONE JSON object only (no markdown), with this exact shape:
{
  "interpretation": "short plain English — what you understood",
  "customerSubstring": string or null — substring to match the activity customer/plant field (e.g. "Bosch"). If the user names a company, prefer a substring that appears in the known-customer list when possible. Null if not customer-specific.
  "keywordGroups": array of arrays — each inner array is OR-synonyms; for each non-empty inner array, at least ONE term must appear in summary or raw text. Example [["issue","problem","defect"]] for "issues". Use [] if no topic/keyword filter (e.g. "all Bosch activity last week").
  "from": string or null — ISO 8601 start (inclusive), UTC,
  "to": string or null — ISO 8601 end (inclusive),
  "includeArchived": boolean — true only if the user explicitly wants archived/historical items
}

Date rules (today in UTC is ${todayUtc}):
- "last week" = previous full calendar week (Monday–Sunday) in local sense; pick UTC dates that reasonably cover it.
- "this week" = Monday 00:00 UTC of current week through end of today UTC.
- "last 7 days" / "past week" = rolling 7 days ending now.
- "last month" = previous calendar month.
- If no time range is implied, use null for from and to.
- If the user says "recent" only, use last 30 days.

Known customer / plant names (hints only; still use customerSubstring the user implied): ${customers || '(none provided)'}

Return only valid JSON.`

  const completion = await createChatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: question.trim() },
    ],
    {
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }
  )

  const raw = getAssistantContent(completion)
  if (!raw) {
    throw new Error('Empty AI response for activity query')
  }

  return JSON.parse(raw)
}

/**
 * @param {Record<string, unknown>} plan
 */
export function buildActivityFilterFromPlan(plan) {
  const filter = {}

  filter.isArchived = Boolean(plan.includeArchived)

  const cust =
    typeof plan.customerSubstring === 'string' && plan.customerSubstring.trim()
      ? plan.customerSubstring.trim()
      : null
  if (cust) {
    filter.customer = new RegExp(escapeRegex(cust), 'i')
  }

  if (plan.from || plan.to) {
    const createdAt = {}
    if (plan.from) {
      const d = new Date(String(plan.from))
      if (!Number.isNaN(d.getTime())) createdAt.$gte = d
    }
    if (plan.to) {
      const d = new Date(String(plan.to))
      if (!Number.isNaN(d.getTime())) createdAt.$lte = d
    }
    if (Object.keys(createdAt).length > 0) {
      filter.createdAt = createdAt
    }
  }

  const groups = Array.isArray(plan.keywordGroups) ? plan.keywordGroups : []
  const andClauses = []
  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) continue
    const terms = group.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    if (terms.length === 0) continue
    const ors = []
    for (const term of terms) {
      const r = new RegExp(escapeRegex(term), 'i')
      ors.push({ summary: r }, { rawConversation: r })
    }
    andClauses.push({ $or: ors })
  }
  if (andClauses.length > 0) {
    filter.$and = andClauses
  }

  return filter
}
