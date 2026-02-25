import { Router } from 'express'
import { isDbConnected } from '../config/db.js'

const router = Router()

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    phase: 1,
    database: isDbConnected() ? 'connected' : 'disconnected'
  })
})

export { router as healthRouter }
