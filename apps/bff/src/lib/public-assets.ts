import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { config } from '../config'

const CONTENT_TYPES: Record<string, string> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

let client: Bun.S3Client | undefined

function publicAssetClient(): Bun.S3Client {
  if (!config.publicAssets.bucket || !config.publicAssets.baseUrl) {
    throw new Error('PUBLIC_ASSET_BUCKET and PUBLIC_ASSET_BASE_URL are required')
  }
  client ??= new Bun.S3Client({
    endpoint: config.objectStore.endpoint,
    bucket: config.publicAssets.bucket,
    accessKeyId: config.objectStore.accessKeyId,
    secretAccessKey: config.objectStore.secretAccessKey,
  })
  return client
}

export interface InspirationUploadTarget {
  key: string
  uploadUrl: string
  publicUrl: string
}

export function createInspirationUploadTarget(input: {
  filename: string
  contentType: string
}): InspirationUploadTarget {
  const suffix = CONTENT_TYPES[input.contentType]
  if (!suffix) throw new Error('unsupported_content_type')
  const claimedSuffix = extname(input.filename).toLowerCase()
  if (
    claimedSuffix &&
    claimedSuffix !== suffix &&
    !(suffix === '.jpg' && claimedSuffix === '.jpeg')
  ) {
    throw new Error('content_type_mismatch')
  }
  const key = `inspirations/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${suffix}`
  return {
    key,
    uploadUrl: publicAssetClient()
      .file(key)
      .presign({
        method: 'PUT',
        expiresIn: 10 * 60,
        type: input.contentType,
      }),
    publicUrl: `${config.publicAssets.baseUrl}/${key}`,
  }
}
