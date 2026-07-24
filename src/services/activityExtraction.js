/**
 * Phase 3 — AI Chat Logging
 * Prompt design + structured JSON extraction for activity logs.
 *
 * This module does NOT save to the database. It only:
 * - Builds a clear prompt for the OpenAI model
 * - Requests strict JSON output describing the activity
 * - Parses and returns the JSON so the caller can review before saving
 * - Deterministically merges labeled barcode-scan lines into structured fields
 */
import { createChatCompletion } from './openai.js'

/**
 * Read the last matching labeled line value from free-form log text
 * (last wins so a newly appended scan overrides older lines).
 * Labels are case-insensitive; value is trimmed.
 *
 * @param {string} rawText
 * @param {string[]} labels
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function labeledLineRegex(label) {
  // Bare "Part:" must not match "Part number:" / "Part name:" / "Part no:".
  if (String(label).toLowerCase() === 'part') {
    return /^Part(?!\s*(?:name|number|no|#))\s*:\s*(.+)$/i
  }
  return new RegExp(`^${escapeRegExp(label)}\\s*:\\s*(.+)$`, 'i')
}

export function readLabeledLine(rawText, labels) {
  if (!rawText || typeof rawText !== 'string') return ''
  // Longest label first so "Part number" wins over "Part".
  const sortedLabels = [...labels].sort((a, b) => b.length - a.length)
  const lines = rawText.split(/\r?\n/)
  let found = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    for (const label of sortedLabels) {
      const m = trimmed.match(labeledLineRegex(label))
      if (m?.[1]?.trim()) {
        found = m[1].trim()
        break
      }
    }
  }
  return found
}

/**
 * Pull the most recent "Scanned barcode:" block from log text
 * (from that header through the following labeled lines).
 *
 * @param {string} rawText
 * @returns {string}
 */
export function extractBarcodeScanBlock(rawText) {
  if (!rawText || typeof rawText !== 'string') return ''
  const lines = rawText.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Scanned barcode\s*:/i.test(lines[i]) || /^\s*Barcode\s*:\s*\S+/i.test(lines[i])) {
      start = i
    }
  }
  if (start < 0) return ''

  const block = []
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (i > start && trimmed === '') break
    // Stop if we hit a new unrelated paragraph that isn't a scan label
    if (
      i > start &&
      trimmed &&
      !/^(Scanned barcode|Barcode|Supplier(?: name)?|Customer|Part(?: name| number| no|#)?|Product(?: name)?|P\/N|PN|Supplier code|Notes?|Serial(?: number)?|S\/N)\s*:/i.test(
        trimmed
      )
    ) {
      break
    }
    block.push(trimmed)
  }
  return block.join('\n').trim()
}

/**
 * Extract customer / part fields from barcode-style labeled lines in the log text.
 * Used so scans populate structured fields even when the model dumps everything into notes.
 *
 * @param {string} rawText
 * @returns {{
 *   customer: string,
 *   partName: string,
 *   partNumber: string,
 *   supplierCode: string,
 *   scanNotes: string,
 *   barcode: string,
 *   scanBlock: string,
 *   hasBarcodeBlock: boolean
 * }}
 */
export function parseBarcodeLabeledFields(rawText) {
  const scanBlock = extractBarcodeScanBlock(rawText)
  const source = scanBlock || rawText
  const customer = readLabeledLine(source, ['Supplier', 'Customer', 'Supplier name'])
  const partName = readLabeledLine(source, ['Part name', 'Product name', 'Product', 'Part'])
  const partNumber = readLabeledLine(source, ['Part number', 'Part no', 'Part #', 'P/N', 'PN'])
  const supplierCode = readLabeledLine(source, ['Supplier code', 'Supplier #'])
  const scanNotes = readLabeledLine(source, ['Notes', 'Note', 'Serial', 'Serial number', 'S/N'])
  const barcode = readLabeledLine(source, ['Scanned barcode', 'Barcode', 'QR code', 'QR'])
  const hasBarcodeBlock = Boolean(scanBlock || barcode || /\bscanned barcode\s*:/i.test(rawText || ''))

  return {
    customer,
    partName,
    partNumber,
    supplierCode: supplierCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5),
    scanNotes,
    barcode,
    scanBlock,
    hasBarcodeBlock,
  }
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/**
 * Prefer explicit labeled barcode/mapping lines over model guesses.
 * Also keeps the scan block in notes (serials and free-form scan notes stay there).
 *
 * @param {any} structured
 * @param {string} rawText
 * @returns {any}
 */
export function mergeBarcodeFieldsIntoStructured(structured, rawText) {
  const base = structured && typeof structured === 'object' ? { ...structured } : {}
  const parsed = parseBarcodeLabeledFields(rawText)

  if (!parsed.hasBarcodeBlock && !parsed.partNumber && !parsed.customer && !parsed.partName) {
    return base
  }

  if (parsed.customer) base.customer = parsed.customer
  if (parsed.partName) {
    base.part_name = parsed.partName
    delete base.partName
  }
  if (parsed.partNumber) {
    base.part_number = parsed.partNumber
    delete base.partNumber
  }
  if (parsed.supplierCode) {
    base.supplier_code = parsed.supplierCode
    delete base.supplierCode
  }

  // Keep scan details in notes when this log includes a barcode block.
  if (parsed.hasBarcodeBlock && parsed.scanBlock) {
    const existingNotes = asNonEmptyString(base.notes)
    if (!existingNotes) {
      base.notes = parsed.scanBlock
    } else if (existingNotes.includes(parsed.scanBlock)) {
      base.notes = existingNotes
    } else if (parsed.scanBlock.includes(existingNotes)) {
      base.notes = parsed.scanBlock
    } else {
      base.notes = `${parsed.scanBlock}\n\n${existingNotes}`
    }
  }

  return base
}

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
  "location": string | null,              // Up to 5 chars — physical spot tag at the plant (cell, aisle, dock, line code), e.g. "A12", "B-7", "ZN102". Letters/digits/dash only, uppercased. null if not stated.
  "area": string | null,                  // e.g. "line", "shop", "incoming quality", "engineering", "quality meeting", "manager-call", etc.
  "source_type": string,                  // One of: "daily-walk", "repair-shop", "incoming-quality", "engineering", "quality-meeting", "manager-call-email", "other"
  "summary": string,                      // One-sentence summary of what happened
  "activity_type": string,                // e.g. "observation", "issue", "follow-up", "normal-production", "other"
  "issue": string | null,                // The specific problem/defect/concern described (for CSV column)
  "resolution": string | null,           // What was done/decided to address the issue (for CSV column)
  "part_name": string | null,             // e.g. "wheel liner", "BCM", "IP", etc.
  "part_number": string | null,           // Supplier / plant part number (from barcode scan text or description)
  "supplier_code": string | null,         // Up to 5 chars — supplier shorthand code; letters/digits only, uppercased
  "vehicle_line": string[],               // Zero or more of: "Super Duty", "Expedition", "Navigator"
  "concern_id": string | null,            // e.g. "Z1900210" or other plant concern / ticket number
  "dtc_code": string | null,              // e.g. "DTC U3000-49" if present
  "intent": string | null,                // What the Apex employee was trying to achieve
  "severity": 0 | 1 | 2 | 3 | null,       // Issue severity for management reports: 0=all good, 1=low, 2=medium, 3=high (see Rules)
  "outcome": string | null,               // What was actually decided or done
  "next_actions": string[],               // List of follow-up actions, empty array if none
  "tags": string[],                       // Short keywords, e.g. ["wheel-liner", "shop", "incoming-quality", "bosch"]
  "time_info": {
    "when": string | null,                // When this happened (ISO 8601 or natural language, if known)
    "duration_minutes": number | null     // Duration in minutes if mentioned or can be inferred
  },
  "confidence": number,                   // 0–1 overall confidence in this extraction
  "notes": string | null                  // Full barcode scan block and/or serial numbers; also ambiguity notes
}

Rules:
- ALWAYS return valid JSON (no comments, no trailing commas).
- "severity": Use 0 when the Apex employee is talking with the operator and everything is normal/no issue. Use 1 (low) for minor observations. Use 2 (medium) for standard quality issues with moderate impact. Use 3 (high) only when the text clearly signals major impact (e.g. line stop, safety, recall risk, repeated customer escalation). Use null if you cannot infer severity—the user will choose before saving.
- "location": A short 1–5 character physical-location tag at the plant (e.g. "A12", "B-7", "ZN102"). Look for phrases like "at A12", "in cell B-7", "line ZN102", "dock 4". Only return letters, digits and dashes (uppercased) and at most 5 characters. If no location is mentioned, return null.
- Barcode / scan blocks (CRITICAL): When the text includes labeled lines like "Scanned barcode:", "Supplier:" / "Customer:", "Part:", "Part number:", "Notes:", you MUST:
  1) Put "Supplier"/"Customer" into "customer" (supplier name).
  2) Put "Part"/"Part name" into "part_name".
  3) Put "Part number" into "part_number".
  4) Put "Supplier code" into "supplier_code" when present.
  5) Still copy the FULL scan block (including serial numbers and free-form Notes) into "notes".
  Do NOT leave part_number / customer empty when those labeled lines are present. Do NOT put the part number only in notes.
- "part_number": Extract when the text mentions a part number, barcode mapping line "Part number: …", or a code in parentheses after a part name. Do not duplicate part_name into part_number. Never treat a serial number as part_number when both are present—serial stays in notes.
- "supplier_code": Up to 5 characters, letters and digits only (uppercased). Only when clearly stated; otherwise null.
- "vehicle_line": Include only values from this exact list when mentioned or implied: "Super Duty", "Expedition", "Navigator". Multiple allowed; empty array if none.
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
    'When barcode scan text is present with labeled fields, always populate customer, part_name, and part_number from those labels, and also keep the full scan text in notes.',
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
- Barcode scans that look like:
  Scanned barcode: 12345
  Supplier: Bosch
  Part: BCM
  Part number: BCZM-1023
  Notes: Serial SN-99881
  → customer="Bosch", part_name="BCM", part_number="BCZM-1023", notes includes the full block (serial stays in notes).

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

  structured = mergeBarcodeFieldsIntoStructured(structured, rawText)

  return {
    structured,
    rawText,
    model: completion.model,
    usage: completion.usage,
  }
}
