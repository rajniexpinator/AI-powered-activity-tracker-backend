/** Allowed highlight target fields for barcode pattern teaching. */
export const PATTERN_FIELDS = [
  'partNumber',
  'partName',
  'customer',
  'supplier',
  'serialNumber',
  'notes',
]

/**
 * Fingerprint barcode shape so similar codes share a taught layout.
 * Alphanumeric runs become length tokens; separators stay as-is.
 * @param {string} barcode
 * @returns {string}
 */
export function buildStructureKey(barcode) {
  const text = typeof barcode === 'string' ? barcode : ''
  return text.replace(/[A-Za-z0-9]+/g, (m) => `A${m.length}`)
}

/**
 * Normalize and validate segment list against a sample barcode.
 * @param {string} sampleBarcode
 * @param {any[]} rawSegments
 * @returns {{ ok: true, segments: { start: number, end: number, field: string }[] } | { ok: false, error: string }}
 */
export function normalizeSegments(sampleBarcode, rawSegments) {
  const sample = typeof sampleBarcode === 'string' ? sampleBarcode : ''
  if (!sample) return { ok: false, error: 'sampleBarcode is required' }
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return { ok: false, error: 'segments must be a non-empty array' }
  }

  const segments = []
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Each segment must be an object with start, end, and field' }
    }
    const start = Number(raw.start)
    const end = Number(raw.end)
    const field = typeof raw.field === 'string' ? raw.field.trim() : ''
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { ok: false, error: 'Segment start/end must be integers' }
    }
    if (start < 0 || end > sample.length || start >= end) {
      return {
        ok: false,
        error: `Segment [${start}, ${end}) is out of range for sample length ${sample.length}`,
      }
    }
    if (!PATTERN_FIELDS.includes(field)) {
      return {
        ok: false,
        error: `Invalid field "${field}". Allowed: ${PATTERN_FIELDS.join(', ')}`,
      }
    }
    segments.push({ start, end, field })
  }

  segments.sort((a, b) => a.start - b.start || a.end - b.end)
  return { ok: true, segments }
}

/**
 * Apply taught segments to a barcode string.
 * Multiple highlights for the same field are joined in highlight order with a space.
 * @param {string} barcode
 * @param {{ start: number, end: number, field: string }[]} segments
 * @returns {Record<string, string>}
 */
export function applySegments(barcode, segments) {
  const text = typeof barcode === 'string' ? barcode : ''
  const fields = {}
  if (!text || !Array.isArray(segments)) return fields

  const ordered = [...segments].sort((a, b) => a.start - b.start || a.end - b.end)
  for (const seg of ordered) {
    const field = seg?.field
    if (!PATTERN_FIELDS.includes(field)) continue
    const start = Number(seg.start)
    const end = Number(seg.end)
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (start < 0 || end > text.length || start >= end) continue
    const piece = text.slice(start, end)
    if (!piece) continue
    fields[field] = fields[field] ? `${fields[field]} ${piece}` : piece
  }
  return fields
}

/**
 * Shape a pattern document for API responses.
 * @param {any} pattern
 * @param {Record<string, string>} [extracted]
 */
export function serializePattern(pattern, extracted) {
  if (!pattern) return null
  const payload = {
    _id: pattern._id,
    name: pattern.name || '',
    sampleBarcode: pattern.sampleBarcode,
    structureKey: pattern.structureKey,
    segments: Array.isArray(pattern.segments)
      ? pattern.segments.map((s) => ({
          start: s.start,
          end: s.end,
          field: s.field,
        }))
      : [],
    isActive: pattern.isActive !== false,
    createdBy: pattern.createdBy,
    updatedBy: pattern.updatedBy,
    createdAt: pattern.createdAt,
    updatedAt: pattern.updatedAt,
  }
  if (extracted && typeof extracted === 'object') {
    payload.extracted = extracted
  }
  return payload
}
