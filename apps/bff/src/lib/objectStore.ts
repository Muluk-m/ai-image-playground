import { config } from '../config'
import { readCapped, SafeFetchError } from './safeFetch'

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
  write(key: string, bytes: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void>
  read(key: string): Promise<Uint8Array<ArrayBuffer>>
  /** 视频这类大对象走这条；小对象整份 `read` 更省一次元信息往返。 */
  open(key: string, signal?: AbortSignal): Promise<ObjectRangeReader>
  listPrefix(prefix: string): Promise<string[]>
  /** 带大小与修改时间的列举。运维看板靠它看「真正落在桶里的备份」，而不是备份脚本的自述。 */
  listEntries(prefix: string): Promise<ObjectEntry[]>
  deletePrefix(prefix: string): Promise<void>
}

/** Metadata rejects oversized objects before any body is requested; the stream remains capped too. */
export async function readObjectWithinLimit(
  store: ObjectStore,
  key: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const object = await store.open(key, signal)
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > maxBytes)
    throw new SafeFetchError('too_large', `内容超过 ${maxBytes} 字节上限`)
  if (object.size === 0) return new Uint8Array(0)
  return readCapped(new Response(object.stream(0, object.size - 1)), maxBytes)
}

export type S3ClientLike = Pick<Bun.S3Client, 'write' | 'file' | 'list' | 'delete'>

/** Keys stored in the database carry no prefix; it is added and stripped only here. */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3ClientLike,
    private readonly keyPrefix: string,
  ) {}

  async write(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal) {
      signal.throwIfAborted()
      // Bun 的 S3.write 没有取消参数；有期限的小对象上传用同一客户端签名的 PUT。
      const url = this.client.file(this.keyPrefix + key).presign({
        method: 'PUT',
        expiresIn: 60,
        type: contentType,
      })
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        // 普通 ArrayBuffer 上的视图直接发，不再整份复制；只有共享内存才需要拷出来。
        body:
          bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : Uint8Array.from(bytes),
        signal,
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error(`Object upload failed (${response.status})`)
      return
    }
    await this.client.write(this.keyPrefix + key, bytes, { type: contentType })
  }

  async read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.client.file(this.keyPrefix + key).arrayBuffer())
  }

  async open(key: string, signal?: AbortSignal): Promise<ObjectRangeReader> {
    const file = this.client.file(this.keyPrefix + key)
    if (!signal) {
      const { size } = await file.stat()
      // S3File.slice 的 end 是开区间，且 .stream() 会把它翻译成上游的 Range 请求。
      return { size, stream: (start, end) => file.slice(start, end + 1).stream() }
    }
    // Bun 的 stat 与 slice().stream() 都不收取消信号；有期限的读取改走同一客户端签名的请求。
    signal.throwIfAborted()
    const response = await fetch(file.presign({ method: 'HEAD', expiresIn: 60 }), {
      method: 'HEAD',
      signal,
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`Object metadata failed (${response.status})`)
    const length = response.headers.get('content-length')
    const size = length === null ? Number.NaN : Number(length)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid object size')
    const url = file.presign({ method: 'GET', expiresIn: 60 })
    return { size, stream: (start, end) => signedRange(url, start, end, signal) }
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

function signedRange(
  url: string,
  start: number,
  end: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  return new ReadableStream({
    async pull(controller) {
      if (!reader) {
        const response = await fetch(url, { headers: { range: `bytes=${start}-${end}` }, signal })
        if (!response.ok || !response.body) {
          await response.body?.cancel()
          throw new Error(`Object read failed (${response.status})`)
        }
        reader = response.body.getReader()
      }
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel: (reason) => reader?.cancel(reason),
  })
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
