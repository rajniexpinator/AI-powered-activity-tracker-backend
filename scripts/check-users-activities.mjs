import mongoose from 'mongoose'
import dotenv from 'dotenv'

dotenv.config()

const emails = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['amason@apexquality.net', 'adams@apexquality.net']

await mongoose.connect(process.env.MONGODB_URI)
const db = mongoose.connection.db

for (const raw of emails) {
  const email = raw.trim().toLowerCase()
  const user = await db.collection('users').findOne({
    email: { $regex: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
  })
  console.log(`\n=== ${email} ===`)
  if (!user) {
    console.log('USER NOT FOUND')
    continue
  }
  console.log('User ID:', user._id)
  console.log('Name:', user.name)
  console.log('Email:', user.email)
  console.log('Role:', user.role)
  console.log('Active:', user.isActive !== false)

  const uid = user._id
  const total = await db.collection('activities').countDocuments({ userId: uid })
  const active = await db.collection('activities').countDocuments({
    userId: uid,
    $or: [{ isArchived: false }, { isArchived: { $exists: false } }],
  })
  const archived = await db.collection('activities').countDocuments({ userId: uid, isArchived: true })
  console.log(`Activities: total=${total} active=${active} archived=${archived}`)

  const recent = await db
    .collection('activities')
    .find({ userId: uid })
    .sort({ createdAt: -1 })
    .limit(8)
    .project({ summary: 1, customer: 1, createdAt: 1, isArchived: 1 })
    .toArray()

  console.log('Recent logs:')
  if (recent.length === 0) console.log('  (none)')
  for (const a of recent) {
    const when = a.createdAt ? new Date(a.createdAt).toISOString() : '?'
    const flag = a.isArchived ? '[ARCHIVED] ' : ''
    console.log(`  - ${when} ${flag}${(a.summary || '').slice(0, 70)}`)
  }
}

const totalActive = await db.collection('activities').countDocuments({
  $or: [{ isArchived: false }, { isArchived: { $exists: false } }],
})
console.log(`\nTotal active activities (all users): ${totalActive}`)
await mongoose.disconnect()
