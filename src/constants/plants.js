export const PLANT_OPTIONS = ['KTP', 'LAP', 'OHAP', 'Oakville', 'Other']

/**
 * Resolved plant label stored on activities (e.g. "KTP" or custom name for Other).
 */
export function resolveReportingPlant(assignedPlant, assignedPlantOther) {
  if (!assignedPlant || !PLANT_OPTIONS.includes(assignedPlant)) return undefined
  if (assignedPlant === 'Other') {
    const custom = typeof assignedPlantOther === 'string' ? assignedPlantOther.trim() : ''
    return custom || undefined
  }
  return assignedPlant
}

/**
 * Normalize plant fields from a PATCH body. Returns null when invalid.
 */
export function normalizeAssignedPlantUpdate(body) {
  if (!body || typeof body !== 'object') return null
  if (!Object.prototype.hasOwnProperty.call(body, 'assignedPlant')) return null

  const raw = body.assignedPlant
  if (raw === null || raw === undefined || raw === '') {
    return { assignedPlant: undefined, assignedPlantOther: undefined }
  }

  if (typeof raw !== 'string' || !PLANT_OPTIONS.includes(raw)) {
    return { error: `assignedPlant must be one of: ${PLANT_OPTIONS.join(', ')}` }
  }

  if (raw === 'Other') {
    const other =
      typeof body.assignedPlantOther === 'string' ? body.assignedPlantOther.trim() : ''
    if (!other) {
      return { error: 'assignedPlantOther is required when assignedPlant is Other' }
    }
    return { assignedPlant: raw, assignedPlantOther: other }
  }

  return { assignedPlant: raw, assignedPlantOther: undefined }
}
