import { Router } from 'express'
import path from 'path'
import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import { protectRoute } from '../middleware/auth.js'
import { uploadSingleImage } from '../middleware/upload.js'
import { isS3Configured, uploadToS3 } from '../services/s3.js'

const router = Router()

const UPLOADS_IMAGES_DIR = path.join(process.cwd(), 'uploads', 'images')

function extFromMime(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  }
  if (map[mime]) return map[mime]
  const sub = (mime && mime.split('/')[1]) || 'bin'
  return sub === 'jpeg' ? 'jpg' : sub
}

function extFromOriginalName(originalname) {
  const name = (originalname || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const raw = name.slice(dot + 1)
  if (raw === 'jpeg') return 'jpg'
  return raw || null
}

function publicUploadFileUrl(req, filename) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '')
  if (configured) return `${configured}/uploads/images/${filename}`
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim()
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim()
  return `${proto}://${host}/uploads/images/${filename}`
}

// POST /api/upload — single image upload (multipart/form-data, field name: image)
router.post('/', protectRoute, (req, res, next) => {
  uploadSingleImage(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Maximum file size up to 10 MB.' })
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
    if (isS3Configured()) {
      const { key, url } = await uploadToS3(
        req.file.buffer,
        req.file.mimetype,
        'activity-tracker'
      )
      return res.status(201).json({ key, url })
    }

    // Local disk fallback when S3 is not configured (dev / small deployments).
    await fs.mkdir(UPLOADS_IMAGES_DIR, { recursive: true })
    const ext =
      extFromOriginalName(req.file.originalname) || extFromMime(req.file.mimetype)
    const filename = `${randomUUID()}.${ext}`
    const dest = path.join(UPLOADS_IMAGES_DIR, filename)
    await fs.writeFile(dest, req.file.buffer)
    const url = publicUploadFileUrl(req, filename)
    res.status(201).json({ key: `local/${filename}`, url })
  } catch (err) {
    next(err)
  }
})

export { router as uploadRouter }
