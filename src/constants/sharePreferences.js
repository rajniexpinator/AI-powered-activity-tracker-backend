export const ACTIVITY_LOG_SHARE_FIELDS = [
  'customer',
  'createdAt',
  'partName',
  'partNumber',
  'summary',
  'photos',
  'files',
]

export const REPORT_SHARE_FIELDS = ['includeContent', 'includePictures']

export const DEFAULT_ACTIVITY_LOG_SHARE = {
  customer: true,
  createdAt: true,
  partName: true,
  partNumber: true,
  summary: true,
  photos: true,
  files: true,
}

export const DEFAULT_REPORT_SHARE = {
  includeContent: true,
  includePictures: true,
}

export const DEFAULT_SHARE_PREFERENCES = {
  activityLog: { ...DEFAULT_ACTIVITY_LOG_SHARE },
  report: { ...DEFAULT_REPORT_SHARE },
}

function pickBooleans(source, keys, defaults) {
  const out = { ...defaults }
  if (!source || typeof source !== 'object') return out
  for (const key of keys) {
    if (typeof source[key] === 'boolean') out[key] = source[key]
  }
  return out
}

export function resolveSharePreferences(user) {
  const raw = user?.sharePreferences
  return {
    activityLog: pickBooleans(raw?.activityLog, ACTIVITY_LOG_SHARE_FIELDS, DEFAULT_ACTIVITY_LOG_SHARE),
    report: pickBooleans(raw?.report, REPORT_SHARE_FIELDS, DEFAULT_REPORT_SHARE),
  }
}

export function normalizeSharePreferencesUpdate(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'sharePreferences')) {
    return null
  }
  const sp = body.sharePreferences
  if (!sp || typeof sp !== 'object') {
    return { error: 'sharePreferences must be an object' }
  }
  return {
    sharePreferences: {
      activityLog: pickBooleans(sp.activityLog, ACTIVITY_LOG_SHARE_FIELDS, DEFAULT_ACTIVITY_LOG_SHARE),
      report: pickBooleans(sp.report, REPORT_SHARE_FIELDS, DEFAULT_REPORT_SHARE),
    },
  }
}
