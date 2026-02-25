import mongoose from 'mongoose'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/activity-tracker'


export async function connectDb() {
  if (mongoose.connection.readyState === 1) return true
  try {
    await mongoose.connect(MONGODB_URI)
    console.log('MongoDB connected')
    return true
  } catch (err) {
    console.warn('MongoDB not available:', err.message)
    console.warn('Server will run without database. Set MONGODB_URI in .env or start MongoDB.')
    return false
  }
}

export async function disconnectDb() {
  if (mongoose.connection.readyState === 0) return
  await mongoose.disconnect()
  console.log('MongoDB disconnected')
}

export function isDbConnected() {
  return mongoose.connection.readyState === 1
}
