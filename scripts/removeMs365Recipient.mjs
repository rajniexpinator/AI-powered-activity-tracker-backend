/**
 * One-off: remove a specific address from Ms365RecipientConfig key `default`.
 * Usage (from Backend): node scripts/removeMs365Recipient.mjs [email]
 */
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import mongoose from 'mongoose'
import { Ms365RecipientConfig } from '../src/models/Ms365RecipientConfig.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

const arg = process.argv[2]?.trim()
const REMOVE = (arg || 'tony.stark003@hotmail.com').toLowerCase()

function filterList(arr) {
  if (!Array.isArray(arr)) return []
  return arr.filter((e) => typeof e === 'string' && e.trim().toLowerCase() !== REMOVE)
}

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/activity-tracker'
await mongoose.connect(uri)

const doc = await Ms365RecipientConfig.findOne({ key: 'default' })
if (!doc) {
  console.log('No Ms365RecipientConfig with key "default" found.')
  await mongoose.disconnect()
  process.exit(0)
}

const prevTo = [...(doc.to || [])]
const prevCc = [...(doc.cc || [])]
doc.to = filterList(doc.to)
doc.cc = filterList(doc.cc)

const changed =
  prevTo.length !== doc.to.length ||
  prevCc.length !== doc.cc.length ||
  prevTo.some((e, i) => e !== doc.to[i]) ||
  prevCc.some((e, i) => e !== doc.cc[i])

if (!changed) {
  console.log(`"${REMOVE}" was not in default to/cc.`)
} else {
  await doc.save()
  console.log(`Removed "${REMOVE}" from default MS365 recipients.`)
  console.log('to:', doc.to)
  console.log('cc:', doc.cc)
}

await mongoose.disconnect()
