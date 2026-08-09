import { config } from '../config'

export interface ObjectStore {
  write(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  read(key: string): Promise<Uint8Array<ArrayBuffer>>
  listPrefix(prefix: string): Promise<string[]>
  deletePrefix(prefix: string): Promise<void>
}

class S3ObjectStore implements ObjectStore {
  private readonly client: Bun.S3Client

  constructor() {
    this.client = new Bun.S3Client({
      endpoint: config.objectStore.endpoint,
      bucket: config.objectStore.bucket,
      accessKeyId: config.objectStore.accessKeyId,
      secretAccessKey: config.objectStore.secretAccessKey,
    })
  }

  async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.write(key, bytes, { type: contentType })
  }

  async read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.client.file(key).arrayBuffer())
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const page = await this.client.list({ prefix, continuationToken })
      for (const entry of page.contents ?? []) {
        if (entry.key) keys.push(entry.key)
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
    } while (continuationToken)
    return keys
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.listPrefix(prefix)) {
      await this.client.delete(key)
    }
  }
}

let productionStore: ObjectStore | undefined
let testStore: ObjectStore | undefined

export function objectStore(): ObjectStore {
  if (testStore) return testStore
  productionStore ??= new S3ObjectStore()
  return productionStore
}

/** Test seam matching the existing upstream transport injection. */
export function setObjectStoreForTesting(store?: ObjectStore): void {
  testStore = store
  if (!store) productionStore = undefined
}
