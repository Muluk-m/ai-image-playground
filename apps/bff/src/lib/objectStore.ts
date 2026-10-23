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
  /** 给了 `signal` 就必须可取消：对象存储卡住时调用方靠它把等待限定在自己的期限内。 */
  read(key: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
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

/** 对象存储按 HTTP 状态拒绝了请求；`status` 用来区分可重试的 5xx 和不必再试的 4xx。 */
/**
 * Bun 的 fetch 传输层错误把完整预签名地址放在可枚举的 `path` 上，消息里也可能带着它。
 * 原样交给日志，签名会先进 Docker/Fluent Bit 原始记录，那时下游的脱敏还没来得及处理。
 * 这里只留名字、错误码和去掉地址的消息。
 */
export function withoutSignedUrl(error: unknown, url: string): unknown {
  if (error instanceof ObjectStoreHttpError || error instanceof DOMException) return error
  const source = error as { name?: unknown; message?: unknown; code?: unknown } | null
  const message = String(source?.message ?? error)
    .split(url)
    .join('<signed-url>')
    .replace(/https?:\/\/\S*X-Amz-\S*/gi, '<signed-url>')
  const clean = new Error(message)
  if (typeof source?.name === 'string') clean.name = source.name
  if (typeof source?.code === 'string' || typeof source?.code === 'number')
    Object.assign(clean, { code: source.code })
  return clean
}

export class ObjectStoreHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ObjectStoreHttpError'
  }
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

  async writeStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    contentType: string,
    size: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const url = this.client
      .file(this.keyPrefix + key)
      .presign({ method: 'PUT', expiresIn: 180, type: contentType })
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'content-length': String(size) },
      body: stream,
      signal,
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`Object upload failed (${response.status})`)
  }

  async read(key: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const file = this.client.file(this.keyPrefix + key)
    if (!signal) return new Uint8Array(await file.arrayBuffer())
    // Bun 的 S3File.arrayBuffer 没有超时也不收取消信号：对端接了连接却不回包时会一直挂着。
    signal.throwIfAborted()
    const url = file.presign({ method: 'GET', expiresIn: 60 })
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) {
        await response.body?.cancel()
        throw new ObjectStoreHttpError(response.status, `Object read failed (${response.status})`)
      }
      return new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      // 只有确实是取消原因本身才原样抛；传输错误和取消撞在一起时仍要脱敏。
      if (signal.aborted && error === signal.reason) throw error
      throw withoutSignedUrl(error, url)
    }
  }

  /**
   * 一次 Range GET 读回对象开头至多 maxBytes 字节，不先发 HEAD 查大小。读多读少由调用方按返回长度判断：
   * 想核对「恰好 n 字节」就传 n + 1，内存上界仍是 n + 1。
   */
  async readUpTo(key: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const file = this.client.file(this.keyPrefix + key)
    try {
      // S3File.slice 的 end 是开区间，.stream() 翻译成上游的 Range 请求。
      return await collectUpTo(file.slice(0, maxBytes).stream(), maxBytes)
    } catch (error) {
      // 零字节对象上的 bytes=0-n 是不可满足的范围（416，Bun 抛 code 为 InvalidRange 的 S3Error），
      // 不是存储故障：查一次大小，确认为空就按读到 0 字节返回，让调用方判成大小不符。
      // 其他错误（网络、权限、上游 5xx）一律原样抛出，不能被当成空对象吞掉。
      if ((error as { code?: unknown } | null)?.code !== 'InvalidRange') throw error
      const size = await file.stat().then(
        (stat) => stat.size,
        () => undefined,
      )
      if (size === 0) return new Uint8Array(0)
      throw error
    }
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

/** 把流收进至多 maxBytes 的缓冲；上游多给也只留前 maxBytes 字节并停止读取。 */
export async function collectUpTo(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = new Uint8Array(maxBytes)
  let offset = 0
  const reader = stream.getReader()
  try {
    while (offset < maxBytes) {
      const part = await reader.read()
      if (part.done) break
      const take = Math.min(part.value.length, maxBytes - offset)
      buffer.set(part.value.subarray(0, take), offset)
      offset += take
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return buffer.subarray(0, offset)
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
