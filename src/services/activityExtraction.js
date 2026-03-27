/**
 * Phase 3 — AI Chat Logging
 * Prompt design + structured JSON extraction for activity logs.
 *
 * This module does NOT save to the database. It only:
 * - Builds a clear prompt for the OpenAI model
 * - Requests strict JSON output describing the activity
 * - Parses and returns the JSON so the caller can review before saving
 */
import { createChatCompletion } from './openai.js'

/**
 * Build the system + user messages that describe how to extract an activity log.
 *
 * @param {string} rawText - Natural language description or chat transcript.
 * @param {object} [options]
 * @param {string} [options.customerHint] - Optional customer / account name hint.
 * @param {string} [options.userEmail] - Optional email of the logged-in user.
 */
export function buildActivityExtractionPrompt(rawText, options = {}) {
  const { customerHint, userEmail } = options

  const schemaDescription = `
You must respond with a single JSON object that matches this schema:
{
  "customer": string | null,              // Tier-1 / Tier-2 supplier name (e.g. "Bosch", "Inoac"), if known
  "oem": string | null,                   // OEM, e.g. "Ford", "GM", "Toyota", "Volvo"
  "plant": string | null,                 // Plant name, e.g. "Kentucky Truck Plant", or null if not stated
  "area": string | null,                  // e.g. "line", "shop", "incoming quality", "engineering", "quality meeting", "manager-call", etc.
  "source_type": string,                  // One of: "daily-walk", "repair-shop", "incoming-quality", "engineering", "quality-meeting", "manager-call-email", "other"
  "summary": string,                      // One-sentence summary of what happened
  "activity_type": string,                // e.g. "observation", "issue", "follow-up", "normal-production", "other"
  "issue": string | null,                // The specific problem/defect/concern described (for CSV column)
  "resolution": string | null,           // What was done/decided to address the issue (for CSV column)
  "part_name": string | null,             // e.g. "wheel liner", "BCM", "IP", etc.
  "concern_id": string | null,            // e.g. "Z1900210" or other plant concern / ticket number
  "dtc_code": string | null,              // e.g. "DTC U3000-49" if present
  "intent": string | null,                // What the Apex employee was trying to achieve
  "outcome": string | null,               // What was actually decided or done
  "next_actions": string[],               // List of follow-up actions, empty array if none
  "tags": string[],                       // Short keywords, e.g. ["wheel-liner", "shop", "incoming-quality", "bosch"]
  "time_info": {
    "when": string | null,                // When this happened (ISO 8601 or natural language, if known)
    "duration_minutes": number | null     // Duration in minutes if mentioned or can be inferred
  },
  "confidence": number,                   // 0–1 overall confidence in this extraction
  "notes": string | null                  // Any important ambiguity or assumptions you made
}

Rules:
- ALWAYS return valid JSON (no comments, no trailing commas).
- If some field is unknown, use null (or [] for arrays) instead of guessing wildly.
- Keep "tags" short and machine-friendly (lowercase, hyphen-separated).
- Use the domain of Apex Quality Control: Apex employees are onsite at OEM plants (mainly Ford) representing suppliers.
- Infer a reasonable "source_type" from context:
  - Daily line walk / operator conversation -> "daily-walk"
  - Repair area / "the shop" -> "repair-shop"
  - Incoming Quality office -> "incoming-quality"
  - Ford engineering discussions -> "engineering"
  - Daily Ford quality meeting -> "quality-meeting"
  - Manager phone/email from Ford -> "manager-call-email"
  - Otherwise -> "other".
`.trim()

  const systemParts = [
    'You are an assistant that converts free-form Apex Quality Control activity descriptions into structured JSON for an internal tracker.',
    'The context is automotive plants where Apex represents Tier-1 / Tier-2 suppliers (e.g. Bosch, Inoac) inside OEM plants (mainly Ford, plus GM/Toyota/Volvo).',
    'Be conservative: when information is missing, set fields to null instead of inventing details.',
  ]

  if (customerHint) {
    systemParts.push(`If it makes sense, use this as the default customer name when matching context: "${customerHint}".`)
  }

  if (userEmail) {
    systemParts.push(`The user who is logging this activity has email: ${userEmail}. Use this only as context (do not put it in the JSON).`)
  }

  const systemMessage = `${systemParts.join(' ')}\n\n${schemaDescription}`

  const userMessage = `
Extract a structured activity from the following Apex log text and respond ONLY with the JSON object.
Examples of situations you understand:
- Daily walk to installation points (e.g. wheel liner job), talking to operators, scanning pallet/part barcodes, taking pictures, and sending information to the supplier.
- Visits to the repair area ("the shop") asking repairmen what was fixed (e.g. BCM replacement, DTC codes, burn smell), inspecting and photographing the part.
- Visits to Incoming Quality, engineering, or daily Ford quality meetings where concerns like Z1900210 or IP cross threads are discussed.
- Manager calls/emails where Ford contacts Apex about an issue, which must be logged by customer, part, and issue.

Now extract the structured activity from:

---
${rawText}
---`.trim()

  return [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userMessage },
  ]
}

/**
 * Call OpenAI to extract a structured activity JSON object from raw text.
 *
 * @param {string} rawText
 * @param {object} [options]
 * @param {string} [options.customerHint]
 * @param {string} [options.userEmail]
 * @returns {Promise<{ structured: any; rawText: string; model: string; usage?: any }>}
 */
export async function extractStructuredActivity(rawText, options = {}) {
  if (!rawText || !rawText.trim()) {
    throw new Error('rawText is required for extraction')
  }

  const messages = buildActivityExtractionPrompt(rawText, options)

  const completion = await createChatCompletion(messages, {
    model: 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
  })

  const choice = completion.choices?.[0]
  const content = choice?.message?.content

  if (!content) {
    throw new Error('OpenAI returned an empty response for activity extraction')
  }

  let structured
  try {
    structured = JSON.parse(content)
  } catch (err) {
    throw new Error('Failed to parse JSON from OpenAI response for activity extraction')
  }

  return {
    structured,
    rawText,
    model: completion.model,
    usage: completion.usage,
  }
}

