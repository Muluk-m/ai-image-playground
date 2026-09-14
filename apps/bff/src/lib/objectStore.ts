import { config } from '../config'

/**
 * 一个已定位、但尚未取字节的对象。`size` 来自元信息请求，用来判定 Range 是否可满足；
 * `stream` 只拉指定区间，进程内存只吃当前 chunk，与对象总大小无关。
 */
export interface ObjectRangeReader {
  readonly size: number
  /** 闭区间 `[start, end]`，边读边发，绝不整份缓冲。 */
  stream(start: number, end: number): ReadableStream<Uint8Array>
}

export interface ObjectStore {
  write(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  read(key: string): Promise<Uint8Array<ArrayBuffer>>
  /** 视频这类大对象走这条；小对象整份 `read` 更省一次元信息往返。 */
  open(key: string): Promise<ObjectRangeReader>
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

  async open(key: string): Promise<ObjectRangeReader> {
    const file = this.client.file(this.keyPrefix + key)
    const { size } = await file.stat()
    // S3File.slice 的 end 是开区间，且 .stream() 会把它翻译成上游的 Range 请求。
    return { size, stream: (start, end) => file.slice(start, end + 1).stream() }
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
