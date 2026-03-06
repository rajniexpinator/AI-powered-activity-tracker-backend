import { Router } from 'express'
import { protectRoute } from '../middleware/auth.js'
import { uploadSingleImage } from '../middleware/upload.js'
import { isS3Configured, uploadToS3 } from '../services/s3.js'

const router = Router()

// POST /api/upload — single image upload (multipart/form-data, field name: image)
router.post('/', protectRoute, (req, res, next) => {
  uploadSingleImage(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 5 MB.' })
      }
      if (err.message && err.message.startsWith('Invalid file type')) {
        return res.status(400).json({ error: err.message })
      }
      return next(err)
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Use field name "image".' })
    }
    next()
  })
}, async (req, res, next) => {
  try {
    if (!isS3Configured()) {
      return res.status(503).json({ error: 'Image upload is not configured (S3 missing).' })
    }

    const { key, url } = await uploadToS3(
      req.file.buffer,
      req.file.mimetype,
      'activity-tracker'
    )

    res.status(201).json({ key, url })
  } catch (err) {
    next(err)
  }
})

export { router as uploadRouter }
