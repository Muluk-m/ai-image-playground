import { config } from '../config'

export interface ObjectStore {
  write(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  read(key: string): Promise<Uint8Array<ArrayBuffer>>
  listPrefix(prefix: string): Promise<string[]>
  deletePrefix(prefix: string): Promise<void>
}

export type S3ClientLike = Pick<Bun.S3Client, 'write' | 'file' | 'list' | 'delete'>

/** Keys stored in the database carry no prefix; it is added and stripped only here. */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3ClientLike,
    private readonly keyPrefix: string,
  ) {}

  async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.write(this.keyPrefix + key, bytes, { type: contentType })
  }

  async read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.client.file(this.keyPrefix + key).arrayBuffer())
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const keys = await this.listBucketKeys(prefix)
    return keys.map((key) => key.slice(this.keyPrefix.length))
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of await this.listBucketKeys(prefix)) {
      await this.client.delete(key)
    }
  }

  private async listBucketKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const page = await this.client.list({
        prefix: this.keyPrefix + prefix,
        continuationToken,
      })
      for (const entry of page.contents ?? []) {
        if (entry.key) keys.push(entry.key)
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
    } while (continuationToken)
    return keys
  }
}

let productionStore: ObjectStore | undefined
let testStore: ObjectStore | undefined

export function objectStore(): ObjectStore {
  if (testStore) return testStore
  productionStore ??= new S3ObjectStore(
    new Bun.S3Client({
      endpoint: config.objectStore.endpoint,
      bucket: config.objectStore.bucket,
      accessKeyId: config.objectStore.accessKeyId,
      secretAccessKey: config.objectStore.secretAccessKey,
    }),
    config.objectStore.keyPrefix,
  )
  return productionStore
}

/** Test seam matching the existing upstream transport injection. */
export function setObjectStoreForTesting(store?: ObjectStore): void {
  testStore = store
  if (!store) productionStore = undefined
}
