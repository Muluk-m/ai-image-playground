import {
  composeQueuePersistence,
  createPostgresPersistence,
  createR2ObjectBucket,
  createSqlitePersistence,
  isPostgresUrl,
  MemoryPixelStore,
  ObjectPixelStore,
} from '@image-playground/db'
import { config } from '../config'
import { log } from '../lib/logger'

function pixelStoreFromEnv() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim()
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
  const bucket = process.env.R2_BUCKET?.trim() || 'ai-images'
  if (accountId && accessKeyId && secretAccessKey) {
    return new ObjectPixelStore(
      createR2ObjectBucket({ accountId, accessKeyId, secretAccessKey, bucket }),
    )
  }
  log.warn(
    { event: 'pixels.memory_fallback' },
    'R2 env missing; pixel store is in-memory and will not survive restarts',
  )
  return new MemoryPixelStore()
}

const sqlite = isPostgresUrl(config.databaseUrl)
  ? null
  : createSqlitePersistence(config.databaseUrl)

export const persistence = sqlite
  ? sqlite
  : composeQueuePersistence(
      await createPostgresPersistence(config.databaseUrl),
      pixelStoreFromEnv(),
    )
export const taskStore = persistence.tasks
export const pixelStore = persistence.pixels
export const db = sqlite?.db as NonNullable<typeof sqlite>['db']
export const schema = sqlite?.schema as NonNullable<typeof sqlite>['schema']
export const checkpointWal = sqlite?.checkpointWal ?? (() => {})
