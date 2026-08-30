import { connect } from 'node:net'
import { normalizeKeyPrefix } from '../apps/bff/src/lib/objectKeyPrefix'

const databaseUrl = process.env.APP_DATABASE_URL
const objectStoreEndpoint = process.env.S3_ENDPOINT
const objectStoreBucket = process.env.S3_BUCKET
const objectStoreAccessKey = process.env.S3_ACCESS_KEY_ID
const objectStoreSecretKey = process.env.S3_SECRET_ACCESS_KEY
const objectStoreKeyPrefix = normalizeKeyPrefix(process.env.S3_KEY_PREFIX)

if (!databaseUrl) throw new Error('APP_DATABASE_URL is required')
if (!objectStoreEndpoint) throw new Error('S3_ENDPOINT is required')
if (!objectStoreBucket) throw new Error('S3_BUCKET is required')
if (!objectStoreAccessKey) throw new Error('S3_ACCESS_KEY_ID is required')
if (!objectStoreSecretKey) throw new Error('S3_SECRET_ACCESS_KEY is required')

if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
  const database = new URL(databaseUrl)
  const databasePort = Number(database.port || '5432')

  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: database.hostname, port: databasePort })
    const timer = setTimeout(
      () => socket.destroy(new Error('database connection timed out')),
      5_000,
    )

    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

// Do not add a vendor readiness endpoint here: R2 has none.
const objectStore = new Bun.S3Client({
  endpoint: objectStoreEndpoint,
  bucket: objectStoreBucket,
  accessKeyId: objectStoreAccessKey,
  secretAccessKey: objectStoreSecretKey,
})
await objectStore.list({ prefix: `${objectStoreKeyPrefix}__deployment_health__/` })
