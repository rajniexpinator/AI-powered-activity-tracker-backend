import { Router } from 'express'
import { authRouter } from './auth.routes.js'

const router = Router()

router.get('/', (_req, res) => {
  res.json({
    name: 'Activity Tracker API',
    version: '0.1.0',
    phase: 2,
    docs: '/api'
  })
})

router.use('/auth', authRouter)


export { router as apiRouter }
