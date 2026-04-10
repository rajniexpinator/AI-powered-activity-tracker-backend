import { isDbConnected } from '../config/db.js'
import { Ms365RecipientConfig } from '../models/Ms365RecipientConfig.js'

function normalizeEmailList(value) {
  if (!value) return []
  const arr = Array.isArray(value) ? value : [value]
  return arr
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

/** Default To/Cc from admin settings (key `default`). Used for weekly drafts and per-log email. */
export async function getDefaultMs365Recipients() {
  if (!isDbConnected()) return { to: [], cc: [] }
  const doc = await Ms365RecipientConfig.findOne({ key: 'default' }).lean()
  return {
    to: normalizeEmailList(doc?.to),
    cc: normalizeEmailList(doc?.cc),
  }
}
