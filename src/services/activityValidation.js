/**
 * Phase 3 — Validation prompts for activity logs.
 *
 * This module uses OpenAI to review a structured activity JSON object
 * (plus the original raw text) and returns issues + suggestions so that
 * the user can review before saving.
 */
import { createChatCompletion } from './openai.js'

/**
 * Validate a structured activity against Apex Quality Control expectations.
 *
 * @param {any} structured - Structured JSON object as produced by extractStructuredActivity
 * @param {string} rawText - Original free-form text
 * @returns {Promise<{ ok: boolean; severity: 'ok' | 'minor' | 'warning' | 'critical'; issues: string[]; suggestions: string[] }>}
 */
export async function validateStructuredActivity(structured, rawText) {
  if (!structured || typeof structured !== 'object') {
    throw new Error('structured activity object is required for validation')
  }
  if (!rawText || !rawText.trim()) {
    throw new Error('rawText is required for validation')
  }

  const systemMessage = `
You are validating a structured activity log for Apex Quality Control.

The JSON describes work of Apex employees inside OEM plants (mainly Ford) representing tier-1 / tier-2 suppliers like Bosch, Inoac, etc.
They log daily walks, repair-shop visits, Incoming Quality issues, engineering discussions, quality meetings and manager calls/emails.

Your goal:
- Check whether the structured JSON is clear and useful for the supplier's engineering and quality teams.
- Do NOT re-generate the JSON, only comment on its quality.

Return a single JSON object with this shape:
{
  "ok": boolean,                        // true if this log is good enough to save without changes
  "severity": "ok" | "minor" | "warning" | "critical",
  "issues": string[],                   // problems or missing information in the structured log
  "suggestions": string[]               // short suggestions to improve the log (what to add or clarify)
}

Guidance:
- Important fields include: customer, oem, part_name, summary, intent, outcome, next_actions.
- If customer or part_name are missing but clearly implied in the raw text, mention that.
- If there is no clear next action but follow-up is implied, call that out.
- If everything is clear and complete, ok = true and severity = "ok" with empty issues/suggestions arrays.
`.trim()

  const userMessage = `
Here is the original free-form activity text:
---
${rawText}
---

Here is the structured JSON that will be saved:
---
${JSON.stringify(structured, null, 2)}
---

Review this structured JSON and respond ONLY with the validation JSON object.
`.trim()

  const completion = await createChatCompletion(
    [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage },
    ],
    {
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
    }
  )

  const choice = completion.choices?.[0]
  const content = choice?.message?.content
  if (!content) {
    throw new Error('OpenAI returned an empty response for activity validation')
  }

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Failed to parse JSON from OpenAI response for activity validation')
  }

  // Basic shape enforcement / defaults
  const ok = typeof parsed.ok === 'boolean' ? parsed.ok : false
  const severity =
    parsed.severity === 'ok' ||
    parsed.severity === 'minor' ||
    parsed.severity === 'warning' ||
    parsed.severity === 'critical'
      ? parsed.severity
      : 'warning'

  const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : []
  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : []

  return { ok, severity, issues, suggestions }
}

