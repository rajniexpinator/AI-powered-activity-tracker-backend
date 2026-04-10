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

// Documents, spreadsheets, zip, video — equipment test data & customer deliverables
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024 // 50 MB (raise nginx client_max_body_size accordingly)

const ATTACHMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'application/rtf',
  'text/rtf',
])

const ATTACHMENT_EXT = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
  '.zip',
  '.mp4',
  '.mov',
  '.webm',
  '.m4v',
  '.json',
  '.xml',
  '.dat',
  '.rtf',
])

function attachmentFileFilter(req, file, cb) {
  const mime = (file.mimetype || '').toLowerCase()
  const name = (file.originalname || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (ATTACHMENT_MIMES.has(mime) || ATTACHMENT_EXT.has(ext)) {
    cb(null, true)
    return
  }
  cb(
    new Error(
      'Invalid attachment type. Allowed: PDF, Word, Excel, CSV, TXT, RTF, ZIP, JSON/XML/DAT, MP4/MOV/WebM.'
    ),
    false
  )
}

export const uploadSingleAttachment = multer({
  storage: multer.memoryStorage(),
  fileFilter: attachmentFileFilter,
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
}).single('file')
