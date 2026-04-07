import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'

const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
const region = process.env.AWS_REGION || 'us-east-1'
const bucket = process.env.AWS_S3_BUCKET
const customEndpoint = process.env.AWS_S3_ENDPOINT

export function isS3Configured() {
  return Boolean(accessKeyId && secretAccessKey && bucket)
}

let s3Client = null

function getClient() {
  if (!isS3Configured()) {
    throw new Error('AWS S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET (and optionally AWS_REGION).')
  }
  if (!s3Client) {
    const endpoint = typeof customEndpoint === 'string' && customEndpoint.trim() ? customEndpoint.trim() : undefined
    s3Client = new S3Client({
      region,
      // Auto-handle bucket region redirects to avoid endpoint mismatch failures.
      followRegionRedirects: true,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    })
  }
  return s3Client
}

/**
 * Upload a file buffer to S3.
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @param {string} [folder] - Optional folder prefix (e.g. 'uploads')
 * @returns {Promise<{ key: string, url: string }>}
 */
export async function uploadToS3(buffer, mimeType, folder = 'uploads', fileExtension = null) {
  let ext = fileExtension
  if (!ext || typeof ext !== 'string') {
    ext = mimeType.split('/')[1] || 'bin'
  }
  ext = String(ext).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'bin'
  const key = `${folder}/${randomUUID()}.${ext}`
  const client = getClient()

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  )

  const url = customEndpoint
    ? `${customEndpoint.replace(/\/$/, '')}/${bucket}/${key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${key}`
  return { key, url }
}
