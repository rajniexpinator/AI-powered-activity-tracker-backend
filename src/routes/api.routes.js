import { Router } from 'express'

const router = Router()

// Base API info
router.get('/', (_req, res) => {
  res.json({
    name: 'Activity Tracker API',
    version: '0.1.0',
    phase: 1,
    docs: '/api'
  })
})

// Phase 2: router.use('/auth', authRoutes)
// Phase 3: router.use('/activities', activityRoutes)
// Phase 4: router.use('/upload', uploadRoutes)
// Phase 5: (activities filter/archive in activityRoutes)
// Phase 6: router.use('/reports', reportRoutes)
// Phase 7: router.use('/email', emailRoutes)
// Phase 8: router.use('/barcodes', barcodeRoutes)

export { router as apiRouter }
