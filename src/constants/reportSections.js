export const REPORT_SECTION_KEYS = [
  'customersVisited',
  'visitSummary',
  'keyActions',
  'risks',
  'nextSteps',
]

export const REPORT_SECTION_LABELS = {
  customersVisited: '1. Customers and Plants Visited',
  visitSummary: '2. Summary of Visits and Issues',
  keyActions: '3. Key Actions Taken',
  risks: '4. Risks and Recommended Follow-Ups',
  nextSteps: '5. Next Steps / Closing',
}

export const DEFAULT_REPORT_SECTIONS = {
  customersVisited: true,
  visitSummary: true,
  keyActions: true,
  risks: true,
  nextSteps: true,
}

export function normalizeReportSections(raw) {
  const out = { ...DEFAULT_REPORT_SECTIONS }
  if (!raw || typeof raw !== 'object') return out
  for (const key of REPORT_SECTION_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  return out
}

export function enabledSectionPromptLines(sections) {
  const normalized = normalizeReportSections(sections)
  return REPORT_SECTION_KEYS.filter((k) => normalized[k]).map((k) => `- ${REPORT_SECTION_LABELS[k]}`)
}
