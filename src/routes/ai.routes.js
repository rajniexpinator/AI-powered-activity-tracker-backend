import { Router } from 'express'
import { protectRoute } from '../middleware/auth.js'
import { isOpenAIAvailable } from '../services/openai.js'
import { extractStructuredActivity } from '../services/activityExtraction.js'
import { validateStructuredActivity } from '../services/activityValidation.js'

const router = Router()

// POST /api/ai/extract-activity
// Body: { text: string, customerHint?: string }
// Returns: { structured, rawText, model, usage }
router.post('/extract-activity', protectRoute, async (req, res, next) => {
  try {
    if (!isOpenAIAvailable()) {
      return res.status(503).json({ error: 'OpenAI integration is not configured on the server' })
    }

    const { text, customerHint } = req.body || {}

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required and must be a non-empty string' })
    }

    const result = await extractStructuredActivity(text, {
      customerHint: typeof customerHint === 'string' ? customerHint : undefined,
      userEmail: req.user?.email,
    })

    // No DB write here — frontend can review and decide whether to save.
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/ai/validate-activity
// Body: { structured: any, rawText: string }
// Returns: { ok, severity, issues, suggestions }
router.post('/validate-activity', protectRoute, async (req, res, next) => {
  try {
    if (!isOpenAIAvailable()) {
      return res.status(503).json({ error: 'OpenAI integration is not configured on the server' })
    }

    const { structured, rawText } = req.body || {}

    if (!structured || typeof structured !== 'object') {
      return res.status(400).json({ error: 'structured is required and must be an object' })
    }
    if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
      return res.status(400).json({ error: 'rawText is required and must be a non-empty string' })
    }

    const validation = await validateStructuredActivity(structured, rawText)
    res.json(validation)
  } catch (err) {
    next(err)
  }
})

export { router as aiRouter }

