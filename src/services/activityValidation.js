/**
 * Phase 3 — Validation prompts for activity logs.
 *
 * This module uses OpenAI to review a structured activity JSON object
 * (plus the original raw text) and returns issues + suggestions so that
 * the user can review before saving.
 */
import { createChatCompletion } from './openai.js'

const SEVERITY_RANK = { ok: 0, minor: 1, warning: 2, critical: 3 }

const BRAND_ALIASES = {
  bosch: ['bosch'],
  magna: ['magna'],
  inoac: ['inoac'],
  denso: ['denso'],
  ford: ['ford'],
  gm: ['gm', 'general motors'],
  toyota: ['toyota'],
  volvo: ['volvo'],
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toTextArray(value) {
  if (Array.isArray(value)) return value.map((v) => asText(v)).filter(Boolean)
  return []
}

function detectBrands(text) {
  const lower = asText(text).toLowerCase()
  if (!lower) return []
  const found = []
  for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
    const hit = aliases.some((alias) => lower.includes(alias))
    if (hit) found.push(brand)
  }
  return found
}

function getRequiredFieldPushback(structured) {
  const issues = []
  const suggestions = []

  const activityType = asText(structured?.activity_type).toLowerCase()
  const issueText = asText(structured?.issue)
  const resolutionText = asText(structured?.resolution)
  const nextActions = toTextArray(structured?.next_actions)
  const partName = asText(structured?.part_name)
  const customer = asText(structured?.customer)
  const summary = asText(structured?.summary)

  if (!customer) {
    issues.push('Customer is missing.')
    suggestions.push('Add the customer name (for example Bosch, Magna, Inoac).')
  }
  if (!summary) {
    issues.push('Summary is missing.')
    suggestions.push('Add a short 1-2 sentence summary of what happened.')
  }

  // Required-by-type checks
  if (activityType === 'issue') {
    if (!issueText) {
      issues.push('Issue details are required for activity_type "issue".')
      suggestions.push('Describe the exact issue or defect observed.')
    }
    if (!resolutionText) {
      issues.push('Resolution is required for activity_type "issue".')
      suggestions.push('Add what action was taken or planned to resolve the issue.')
    }
    if (nextActions.length === 0) {
      issues.push('Next actions are required for activity_type "issue".')
      suggestions.push('Add at least one follow-up action and owner/timing if known.')
    }
  }

  if (activityType === 'follow-up') {
    if (nextActions.length === 0) {
      issues.push('Next actions are required for activity_type "follow-up".')
      suggestions.push('Add at least one explicit follow-up action.')
    }
    if (!resolutionText && !asText(structured?.outcome)) {
      issues.push('Outcome or resolution is required for activity_type "follow-up".')
      suggestions.push('Add the current outcome or latest resolution status.')
    }
  }

  if (activityType === 'observation' && !partName && !issueText) {
    issues.push('Observation entries should include at least part name or issue detail.')
    suggestions.push('Add part_name and/or issue so this observation is useful for reporting.')
  }

  return { issues, suggestions }
}

function getBrandMismatchPushback(structured, rawText) {
  const issues = []
  const suggestions = []
  const customer = asText(structured?.customer)
  const detectedInRaw = detectBrands(rawText)

  if (!customer || detectedInRaw.length === 0) return { issues, suggestions }

  const normalizedCustomer = customer.toLowerCase()
  const customerBrand =
    Object.keys(BRAND_ALIASES).find((brand) =>
      [brand, ...BRAND_ALIASES[brand]].some((alias) => normalizedCustomer.includes(alias))
    ) || null

  if (!customerBrand) return { issues, suggestions }

  const containsCustomerBrandInRaw = detectedInRaw.includes(customerBrand)
  const otherBrands = detectedInRaw.filter((b) => b !== customerBrand)

  if (!containsCustomerBrandInRaw && otherBrands.length > 0) {
    issues.push(
      `Potential customer mismatch: selected customer is "${customer}" but raw notes mention ${otherBrands.join(
        ', '
      )}.`
    )
    suggestions.push(
      'Confirm customer and part ownership before saving (for example Bosch vs Magna mix-up).'
    )
  }

  return { issues, suggestions }
}

function getImagePushback(structured, imageCount) {
  const issues = []
  const suggestions = []
  const activityType = asText(structured?.activity_type).toLowerCase()
  const issueText = asText(structured?.issue)
  const hasIssueContext = activityType === 'issue' || issueText.length > 0

  if (hasIssueContext && imageCount === 0) {
    issues.push('No photo uploaded for an issue-related activity.')
    suggestions.push('Upload at least one photo (defect, part label/barcode, or workstation evidence).')
  }

  return { issues, suggestions }
}

function mergeValidation(ruleValidation, aiValidation) {
  const issues = [...new Set([...(ruleValidation.issues || []), ...(aiValidation.issues || [])])]
  const suggestions = [
    ...new Set([...(ruleValidation.suggestions || []), ...(aiValidation.suggestions || [])]),
  ]

  const aiSeverity =
    aiValidation.severity === 'ok' ||
    aiValidation.severity === 'minor' ||
    aiValidation.severity === 'warning' ||
    aiValidation.severity === 'critical'
      ? aiValidation.severity
      : 'warning'

  const ruleSeverity =
    ruleValidation.severity === 'ok' ||
    ruleValidation.severity === 'minor' ||
    ruleValidation.severity === 'warning' ||
    ruleValidation.severity === 'critical'
      ? ruleValidation.severity
      : 'ok'

  const severity = SEVERITY_RANK[ruleSeverity] >= SEVERITY_RANK[aiSeverity] ? ruleSeverity : aiSeverity
  const ok = aiValidation.ok === true && ruleValidation.ok === true && issues.length === 0

  return { ok, severity, issues, suggestions }
}

/**
 * Validate a structured activity against Apex Quality Control expectations.
 *
 * @param {any} structured - Structured JSON object as produced by extractStructuredActivity
 * @param {string} rawText - Original free-form text
 * @param {string[]} [images] - Optional uploaded image URLs for pushback checks
 * @returns {Promise<{ ok: boolean; severity: 'ok' | 'minor' | 'warning' | 'critical'; issues: string[]; suggestions: string[] }>}
 */
export async function validateStructuredActivity(structured, rawText, images = []) {
  if (!structured || typeof structured !== 'object') {
    throw new Error('structured activity object is required for validation')
  }
  if (!rawText || !rawText.trim()) {
    throw new Error('rawText is required for validation')
  }

  const imageCount = Array.isArray(images) ? images.filter((url) => typeof url === 'string' && url.trim()).length : 0

  const requiredFieldChecks = getRequiredFieldPushback(structured)
  const brandChecks = getBrandMismatchPushback(structured, rawText)
  const imageChecks = getImagePushback(structured, imageCount)
  const ruleIssues = [...requiredFieldChecks.issues, ...brandChecks.issues, ...imageChecks.issues]
  const ruleSuggestions = [
    ...requiredFieldChecks.suggestions,
    ...brandChecks.suggestions,
    ...imageChecks.suggestions,
  ]
  const ruleValidation = {
    ok: ruleIssues.length === 0,
    severity: ruleIssues.length === 0 ? 'ok' : ruleIssues.length >= 3 ? 'critical' : 'warning',
    issues: ruleIssues,
    suggestions: ruleSuggestions,
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
- Important fields include: customer, oem, part_name, summary, intent, outcome, issue, resolution, next_actions.
- If customer or part_name are missing but clearly implied in the raw text, mention that.
- If issue or resolution are missing but clearly implied in the raw text, mention that.
- If there is no clear next action but follow-up is implied, call that out.
- Enforce pushback checks:
  - If notes suggest customer/brand mismatch (example Bosch vs Magna), call it out.
  - If activity is issue-related and no photos are attached, warn the user.
  - For activity_type "issue", ensure issue + resolution + next_actions are present.
  - For activity_type "follow-up", ensure next_actions and outcome/resolution are present.
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

Attached image count: ${imageCount}

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

  const aiValidation = {
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : false,
    severity:
    parsed.severity === 'ok' ||
    parsed.severity === 'minor' ||
    parsed.severity === 'warning' ||
    parsed.severity === 'critical'
      ? parsed.severity
      : 'warning',
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
  }

  return mergeValidation(ruleValidation, aiValidation)
}

