import { Router } from 'express'
import { protectRoute } from '../middleware/auth.js'
import { Activity } from '../models/Activity.js'

const router = Router()

// POST /api/activities
// Body: { rawText: string, structured: any }
// Saves a new Activity linked to the logged-in user.
router.post('/', protectRoute, async (req, res, next) => {
  try {
    const { rawText, structured } = req.body || {}

    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      return res.status(400).json({ error: 'rawText is required and must be a non-empty string' })
    }

    if (!structured || typeof structured !== 'object') {
      return res.status(400).json({ error: 'structured is required and must be an object' })
    }

    const summary =
      typeof structured.summary === 'string' && structured.summary.trim()
        ? structured.summary.trim()
        : rawText.slice(0, 160)

    const customer =
      typeof structured.customer === 'string' && structured.customer.trim()
        ? structured.customer.trim()
        : undefined

    const activity = await Activity.create({
      userId: req.user._id,
      customer,
      summary,
      rawConversation: rawText,
      structuredData: structured,
    })

    res.status(201).json({ activity })
  } catch (err) {
    next(err)
  }
})

export { router as activitiesRouter }

