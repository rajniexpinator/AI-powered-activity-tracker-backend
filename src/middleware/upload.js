import multer from 'multer'

// Per-image cap (must match frontend messaging and any reverse-proxy body limits).
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const ALLOWED_MIMES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
]

const storage = multer.memoryStorage()

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'])

function fileFilter(req, file, cb) {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true)
    return
  }
  // iOS / some browsers send empty or generic MIME for camera picks.
  const name = (file.originalname || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (ALLOWED_EXT.has(ext)) {
    cb(null, true)
    return
  }
  cb(new Error(`Invalid file type. Allowed: ${ALLOWED_MIMES.join(', ')}`), false)
}

export const uploadSingleImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
}).single('image')
