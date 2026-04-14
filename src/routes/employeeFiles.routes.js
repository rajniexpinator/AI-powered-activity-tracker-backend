import path from 'path'
import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import { Router } from 'express'
import mongoose from 'mongoose'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { uploadSingleAttachment } from '../middleware/upload.js'
import { EmployeeFile } from '../models/EmployeeFile.js'
import { isS3Configured, uploadToS3, getPresignedDownloadUrl, deleteFromS3 } from '../services/s3.js'

const router = Router()

/** Local disk mirror — must NOT overlap uploads/images, uploads/attachments (quality / AI logs). */
const UPLOADS_HR_RESOURCES_DIR = path.join(process.cwd(), 'uploads', 'internal-hr-resources')
const LEGACY_HR_UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'employee-files')

function extFromMime(mime) {
  const map = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
  }
  if (map[mime]) return map[mime]
  const sub = (mime && mime.split('/')[1]) || 'bin'
  return sub.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'bin'
}

function extFromOriginalName(originalname) {
  const name = (originalname || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const raw = name.slice(dot + 1)
  if (raw === 'jpeg') return 'jpg'
  return raw || null
}

function safeBaseName(originalname) {
  return path.basename(originalname || 'file').replace(/[^\w.\- ()+\[\]]+/g, '_').slice(0, 180)
}

function publicLocalHrFileUrl(req, filename, uploadsSubfolder) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '')
  if (configured) return `${configured}/uploads/${uploadsSubfolder}/${filename}`
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim()
  const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim()
  return `${proto}://${host}/uploads/${uploadsSubfolder}/${filename}`
}

async function resolveLocalHrDiskPath(filename) {
  const primary = path.join(UPLOADS_HR_RESOURCES_DIR, filename)
  try {
    await fs.access(primary)
    return primary
  } catch {
    const legacy = path.join(LEGACY_HR_UPLOADS_DIR, filename)
    await fs.access(legacy)
    return legacy
  }
}

// GET /api/employee-files — list (all authenticated users)
router.get('/', protectRoute, async (_req, res, next) => {
  try {
    const docs = await EmployeeFile.find().sort({ createdAt: -1 }).populate('uploadedBy', 'name email').lean()
    const files = docs.map((d) => ({
      _id: d._id,
      title: d.title,
      description: d.description,
      originalName: d.originalName,
      mimeType: d.mimeType,
      size: d.size,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      uploadedBy: d.uploadedBy
        ? { _id: d.uploadedBy._id, name: d.uploadedBy.name, email: d.uploadedBy.email }
        : null,
    }))
    res.json({ files })
  } catch (e) {
    next(e)
  }
})

// POST /api/employee-files — upload (admin only), field name: file
router.post(
  '/',
  protectRoute,
  requireRole('admin'),
  (req, res, next) => {
    uploadSingleAttachment(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Maximum file size is 50 MB.' })
        }
        if (err.message && err.message.startsWith('Invalid attachment type')) {
          return res.status(400).json({ error: err.message })
        }
        return next(err)
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Use field name "file".' })
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const safeName = safeBaseName(req.file.originalname)
      const titleRaw = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
      const title = titleRaw || safeName.replace(/\.[^.]+$/, '') || 'Document'
      const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 2000) : ''

      const extFromName = (extFromOriginalName(safeName) || extFromMime(req.file.mimetype) || 'bin').replace(
        /[^a-zA-Z0-9]/g,
        ''
      )

      let storage
      let s3Key = null
      let localFilename = null

      if (isS3Configured()) {
        // Same bucket as app uploads, but prefix is separate from activity-tracker/* (quality / AI log files).
        const { key } = await uploadToS3(
          req.file.buffer,
          req.file.mimetype,
          'internal-hr-resources',
          extFromName || 'bin'
        )
        storage = 's3'
        s3Key = key
      } else {
        await fs.mkdir(UPLOADS_HR_RESOURCES_DIR, { recursive: true })
        const ext = extFromOriginalName(safeName) || extFromMime(req.file.mimetype) || 'bin'
        const filename = `${randomUUID()}.${ext}`
        const dest = path.join(UPLOADS_HR_RESOURCES_DIR, filename)
        await fs.writeFile(dest, req.file.buffer)
        storage = 'local'
        localFilename = filename
      }

      const doc = await EmployeeFile.create({
        title,
        description,
        storage,
        s3Key,
        localFilename,
        originalName: safeName,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedBy: req.user._id,
      })
      const populated = await EmployeeFile.findById(doc._id).populate('uploadedBy', 'name email').lean()
      const safe = {
        _id: populated._id,
        title: populated.title,
        description: populated.description,
        originalName: populated.originalName,
        mimeType: populated.mimeType,
        size: populated.size,
        createdAt: populated.createdAt,
        updatedAt: populated.updatedAt,
        uploadedBy: populated.uploadedBy,
      }
      res.status(201).json({ file: safe })
    } catch (e) {
      next(e)
    }
  }
)

// GET /api/employee-files/:id/download — presigned or public URL (authenticated)
router.get('/:id/download', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const doc = await EmployeeFile.findById(id).lean()
    if (!doc) {
      return res.status(404).json({ error: 'File not found' })
    }
    if (doc.storage === 's3' && doc.s3Key) {
      if (!isS3Configured()) {
        return res.status(503).json({ error: 'File storage is not available.' })
      }
      const url = await getPresignedDownloadUrl(doc.s3Key, 3600)
      return res.json({ url, expiresIn: 3600, filename: doc.originalName || doc.title })
    }
    if (doc.storage === 'local' && doc.localFilename) {
      try {
        const diskPath = await resolveLocalHrDiskPath(doc.localFilename)
        const sub = diskPath.startsWith(LEGACY_HR_UPLOADS_DIR) ? 'employee-files' : 'internal-hr-resources'
        const url = publicLocalHrFileUrl(req, doc.localFilename, sub)
        return res.json({ url, filename: doc.originalName || doc.title })
      } catch {
        return res.status(404).json({ error: 'File not found on server' })
      }
    }
    return res.status(500).json({ error: 'Invalid file record' })
  } catch (e) {
    next(e)
  }
})

// DELETE /api/employee-files/:id — admin only
router.delete('/:id', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const doc = await EmployeeFile.findById(id)
    if (!doc) {
      return res.status(404).json({ error: 'File not found' })
    }
    if (doc.storage === 's3' && doc.s3Key && isS3Configured()) {
      try {
        await deleteFromS3(doc.s3Key)
      } catch (e) {
        console.error('S3 delete failed', e)
      }
    } else if (doc.storage === 'local' && doc.localFilename) {
      try {
        const diskPath = await resolveLocalHrDiskPath(doc.localFilename)
        await fs.unlink(diskPath)
      } catch {
        // ignore missing file
      }
    }
    await doc.deleteOne()
    res.json({ success: true })
  } catch (e) {
    next(e)
  }
})

export { router as employeeFilesRouter }
