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

/** 桶里的一个对象连同它的元信息。`lastModified` 是毫秒时间戳。 */
export interface ObjectEntry {
  key: string
  size: number
  lastModified: number
}

export interface ObjectStore {
  write(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  read(key: string): Promise<Uint8Array<ArrayBuffer>>
  /** 视频这类大对象走这条；小对象整份 `read` 更省一次元信息往返。 */
  open(key: string): Promise<ObjectRangeReader>
  listPrefix(prefix: string): Promise<string[]>
  /** 带大小与修改时间的列举。运维看板靠它看「真正落在桶里的备份」，而不是备份脚本的自述。 */
  listEntries(prefix: string): Promise<ObjectEntry[]>
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
    const entries = await this.listBucketEntries(prefix)
    return entries.map((entry) => entry.key.slice(this.keyPrefix.length))
  }

  async listEntries(prefix: string): Promise<ObjectEntry[]> {
    const entries = await this.listBucketEntries(prefix)
    return entries.map((entry) => ({ ...entry, key: entry.key.slice(this.keyPrefix.length) }))
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const entry of await this.listBucketEntries(prefix)) {
      await this.client.delete(entry.key)
    }
  }

  private async listBucketEntries(prefix: string): Promise<ObjectEntry[]> {
    const entries: ObjectEntry[] = []
    let continuationToken: string | undefined
    do {
      const page = await this.client.list({
        prefix: this.keyPrefix + prefix,
        continuationToken,
      })
      for (const entry of page.contents ?? []) {
        if (!entry.key) continue
        entries.push({
          key: entry.key,
          size: Number(entry.size ?? 0),
          lastModified: entry.lastModified ? new Date(entry.lastModified).getTime() : 0,
        })
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
    } while (continuationToken)
    return entries
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
