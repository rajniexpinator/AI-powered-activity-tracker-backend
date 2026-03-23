import 'dotenv/config'
import { connectDb, disconnectDb } from '../config/db.js'
import { Customer } from '../models/Customer.js'
import { User } from '../models/User.js'

const CUSTOMER_NAMES = [
  'Bosch',
  'Brose',
  'Hanon',
  'Tiffs',
  'Thyssenkrupp',
  'Nexteer',
  'Visteon',
  'Magna',
  'Continental',
  'Agrati',
  'Cadillac Products',
  'Flexitech',
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function run() {
  const connected = await connectDb()
  if (!connected) {
    console.error('Database connection failed. Could not seed customers.')
    process.exitCode = 1
    return
  }

  const seedUser =
    (await User.findOne({ role: 'admin', isActive: true }).select('_id').lean()) ||
    (await User.findOne({ isActive: true }).select('_id').lean())

  if (!seedUser?._id) {
    console.error('No active user found. Create at least one user before seeding customers.')
    process.exitCode = 1
    return
  }

  let created = 0
  let alreadyPresent = 0

  for (const name of CUSTOMER_NAMES) {
    const existing = await Customer.findOne({ name: new RegExp(`^${escapeRegExp(name)}$`, 'i') })
      .select('_id')
      .lean()

    if (existing) {
      alreadyPresent += 1
      continue
    }

    await Customer.create({
      name,
      createdBy: seedUser._id,
      isActive: true,
    })
    created += 1
  }

  console.log(`Customer seed complete. Created: ${created}, Already present: ${alreadyPresent}`)
}

run()
  .catch((err) => {
    console.error('Customer seed failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnectDb()
  })
