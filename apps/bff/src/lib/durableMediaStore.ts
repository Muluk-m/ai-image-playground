import { config } from '../config'
import { type ObjectStore, type S3ClientLike, S3ObjectStore } from './objectStore'

export interface DurableMediaStore extends ObjectStore {
  sign(key: string, method: 'GET' | 'PUT', contentType?: string): string
}

let production: DurableMediaStore | undefined
let testing: DurableMediaStore | undefined

export function durableMediaStore(): DurableMediaStore {
  if (testing) return testing
  if (!production) {
    const client = new Bun.S3Client({
      endpoint: config.objectStore.endpoint,
      bucket: config.objectStore.bucket,
      accessKeyId: config.objectStore.accessKeyId,
      secretAccessKey: config.objectStore.secretAccessKey,
    })
    production = createDurableMediaStore(client, config.objectStore.keyPrefix)
  }
  return production
}

export function setDurableMediaStoreForTesting(store?: DurableMediaStore) {
  testing = store
  production = undefined
}

export function createDurableMediaStore(
  client: S3ClientLike & Pick<Bun.S3Client, 'presign'>,
  deploymentPrefix: string,
): DurableMediaStore {
  // The ordinary deployment prefix expires after 45 days; durable objects must be outside it.
  const prefix = `durable/${deploymentPrefix}`
  return Object.assign(new S3ObjectStore(client, prefix), {
    sign: (key: string, method: 'GET' | 'PUT', contentType?: string) =>
      client.presign(prefix + key, {
        method,
        expiresIn: 600,
        ...(contentType ? { type: contentType } : {}),
      }),
  })
}
