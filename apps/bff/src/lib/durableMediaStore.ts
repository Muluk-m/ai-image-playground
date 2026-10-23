import { config } from '../config'
import { type ObjectStore, type S3ClientLike, S3ObjectStore } from './objectStore'

export interface DurableMediaStore extends ObjectStore {
  writeStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    contentType: string,
    size: number,
    signal: AbortSignal,
  ): Promise<void>
  sign(key: string, method: 'GET' | 'PUT', contentType?: string): string
  /** 一次请求读回至多 maxBytes 字节（不先查大小），见 S3ObjectStore.readUpTo。 */
  readUpTo(key: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>>
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
