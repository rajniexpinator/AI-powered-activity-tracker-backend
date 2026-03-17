import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'

import { connectDb } from './config/db.js'
import { healthRouter, apiRouter } from './routes/index.js'
import { errorHandler, notFound } from './middleware/errorHandler.js'

const app = express()
const PORT = process.env.PORT || 5000

// Security
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}))
app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true
}))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

app.use('/health', healthRouter)
app.use('/api', apiRouter)

// 404 and error handling
app.use(notFound)
app.use(errorHandler)

async function start() {
  await connectDb()
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

start()
