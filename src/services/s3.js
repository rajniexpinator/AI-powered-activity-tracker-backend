import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'

const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
const region = process.env.AWS_REGION || 'us-east-1'
const bucket = process.env.AWS_S3_BUCKET

export function isS3Configured() {
  return Boolean(accessKeyId && secretAccessKey && bucket)
}

let s3Client = null

function getClient() {
  if (!isS3Configured()) {
    throw new Error('AWS S3 is not configured. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET (and optionally AWS_REGION).')
  }
  if (!s3Client) {
    s3Client = new S3Client({
      region,
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
export async function uploadToS3(buffer, mimeType, folder = 'uploads') {
  const ext = mimeType.split('/')[1] || 'bin'
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

  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`
  return { key, url }
}
