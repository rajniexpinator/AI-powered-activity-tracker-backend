import { Router } from 'express'
import { authRouter } from './auth.routes.js'
import { aiRouter } from './ai.routes.js'
import { activitiesRouter } from './activities.routes.js'
import { customersRouter } from './customers.routes.js'

const router = Router()

router.get('/', (_req, res) => {
  res.json({
    name: 'Activity Tracker API',
    version: '0.1.0',
    phase: 3,
    docs: '/api'
  })
})

router.use('/auth', authRouter)
router.use('/ai', aiRouter)
router.use('/activities', activitiesRouter)
router.use('/customers', customersRouter)

export { router as apiRouter }
