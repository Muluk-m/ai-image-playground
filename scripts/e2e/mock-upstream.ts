import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { solidPng } from './png.ts'

/**
 * 可复用的 mock 上游，一个进程里起两个本地 HTTP 服务：
 *
 * - 图片上游：BFF 走通用网关（UPSTREAM_BASE_URL）时发的 OpenAI Images 协议，
 *   文生图 `POST /v1/images/generations`（JSON），改图 `POST /v1/images/edits`（multipart，
 *   参考图字段 `image[]`）。返回确定性的纯色 PNG（`data[].b64_json`），不花钱、不联网。
 * - 对象存储：BFF 的 S3 接口最小子集（PUT/GET/HEAD/DELETE/ListObjectsV2），放在内存里，
 *   省掉 MinIO 容器。
 *
 * 每个上游请求都被记录下来，场景据此断言「BFF 实际发给上游的是什么、发了几次」。
 */

export interface RecordedFile {
  readonly field: string
  readonly name: string
  readonly type: string
  readonly bytes: number
  readonly sha256: string
}

export interface RecordedRequest {
  readonly at: number
  readonly method: string
  readonly path: string
  readonly kind: 'generate' | 'edit' | 'other'
  readonly authorization: string | null
  readonly model: string | null
  readonly prompt: string | null
  readonly size: string | null
  readonly n: number
  readonly fields: Readonly<Record<string, string>>
  readonly files: readonly RecordedFile[]
}

export interface UpstreamBehavior {
  /** 每个上游请求先等这么久再回（毫秒）。 */
  delayMs: number
  /** 接下来这么多个请求直接失败（不出图），用完恢复正常。 */
  failNext: number
  /** 失败时的 HTTP 状态。 */
  failStatus: number
}

const DEFAULT_BEHAVIOR: UpstreamBehavior = { delayMs: 0, failNext: 0, failStatus: 500 }

export interface MockUpstream {
  /** 图片上游的 origin，作为 BFF 的 UPSTREAM_BASE_URL。 */
  readonly url: string
  /** 对象存储的 origin，作为 BFF 的 S3_ENDPOINT。 */
  readonly s3Url: string
  readonly bucket: string
  /** 到目前为止收到的图片请求，按到达顺序。 */
  requests(): readonly RecordedRequest[]
  /** 只看会出图的请求（生图与改图）。 */
  imageRequests(): readonly RecordedRequest[]
  /** 还没回完的图片请求数。 */
  inflight(): number
  /** 等所有在途的图片请求结束（场景失败后进入下一个场景之前调用）。 */
  settle(timeoutMs?: number): Promise<void>
  /** 改行为；只覆盖传入的字段。 */
  configure(next: Partial<UpstreamBehavior>): void
  /** 清空记录并恢复默认行为（对象存储里的内容保留，BFF 已落库的产物还在引用它）。 */
  reset(): void
  close(): Promise<void>
}

export const MOCK_BUCKET = 'e2e'

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => parts.push(part))
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function describe(req: IncomingMessage, body: Buffer): Promise<RecordedRequest> {
  const path = new URL(req.url ?? '/', 'http://mock').pathname
  const contentType = req.headers['content-type'] ?? ''
  const fields: Record<string, string> = {}
  const files: RecordedFile[] = []
  if (contentType.startsWith('multipart/form-data')) {
    const form = await new Response(new Uint8Array(body), {
      headers: { 'content-type': contentType },
    }).formData()
    // bun 的类型把 FormData 的值声明成了 string，实际运行时文件字段是 File。
    for (const [field, entry] of form.entries() as Iterable<[string, string | File]>) {
      if (typeof entry === 'string') {
        fields[field] = entry
        continue
      }
      const bytes = Buffer.from(await entry.arrayBuffer())
      files.push({
        field,
        name: entry.name,
        type: entry.type,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  } else if (contentType.includes('json') && body.length > 0) {
    try {
      const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      for (const [field, value] of Object.entries(json)) {
        fields[field] = typeof value === 'string' ? value : JSON.stringify(value)
      }
    } catch {
      // 不是合法 JSON 就只留空字段，由场景的断言去发现。
    }
  }
  const kind = path.endsWith('/images/generations')
    ? 'generate'
    : path.endsWith('/images/edits')
      ? 'edit'
      : 'other'
  const n = Number(fields.n ?? 1)
  return {
    at: Date.now(),
    method: req.method ?? 'GET',
    path,
    kind,
    authorization: req.headers.authorization ?? null,
    model: fields.model ?? null,
    prompt: fields.prompt ?? null,
    size: fields.size ?? null,
    n: Number.isInteger(n) && n > 0 ? n : 1,
    fields,
    files,
  }
}

function startImageUpstream(state: { behavior: UpstreamBehavior; log: RecordedRequest[] }): Server {
  return createServer(async (req, res) => {
    const body = await readBody(req)
    const request = await describe(req, body)
    state.log.push(request)
    if (request.kind === 'other') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}')
      return
    }
    const { delayMs } = state.behavior
    if (delayMs > 0) await sleep(delayMs)
    if (state.behavior.failNext > 0) {
      state.behavior.failNext -= 1
      res
        .writeHead(state.behavior.failStatus, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'mock upstream failure' } }))
      return
    }
    // 同一个提示词、同一个序号永远是同一张图；不同提示词颜色不同，场景里能分辨。
    const data = Array.from({ length: request.n }, (_, index) => ({
      b64_json: solidPng(`${request.prompt ?? ''}#${index}`).toString('base64'),
    }))
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }))
  })
}

interface StoredObject {
  readonly bytes: Buffer
  readonly type: string
  readonly modified: Date
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${body}`
}

const escapeXml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function respondObject(
  req: IncomingMessage,
  res: ServerResponse,
  object: StoredObject | undefined,
): void {
  if (!object) {
    res
      .writeHead(404, { 'content-type': 'application/xml' })
      .end(xml('<Error><Code>NoSuchKey</Code><Message>not found</Message></Error>'))
    return
  }
  const headers = {
    'content-type': object.type,
    'accept-ranges': 'bytes',
    etag: `"${createHash('md5').update(object.bytes).digest('hex')}"`,
    'last-modified': object.modified.toUTCString(),
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range) {
    const total = object.bytes.length
    const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
    if (start >= total || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${total}` }).end()
      return
    }
    const slice = object.bytes.subarray(start, end + 1)
    res
      .writeHead(206, {
        ...headers,
        'content-length': slice.length,
        'content-range': `bytes ${start}-${end}/${total}`,
      })
      .end(req.method === 'HEAD' ? undefined : slice)
    return
  }
  res
    .writeHead(200, { ...headers, 'content-length': object.bytes.length })
    .end(req.method === 'HEAD' ? undefined : object.bytes)
}

function startObjectStore(objects: Map<string, StoredObject>): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://s3')
    // 路径风格：/<bucket>/<key>
    const [, bucket = '', ...rest] = url.pathname.split('/')
    const key = decodeURIComponent(rest.join('/'))
    if (bucket !== MOCK_BUCKET) {
      res.writeHead(404).end()
      return
    }
    const body = await readBody(req)
    if (!key) {
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        for (const match of body.toString('utf8').matchAll(/<Key>([^<]*)<\/Key>/g)) {
          objects.delete((match[1] ?? '').replaceAll('&amp;', '&'))
        }
        res.writeHead(200, { 'content-type': 'application/xml' }).end(xml('<DeleteResult/>'))
        return
      }
      const prefix = url.searchParams.get('prefix') ?? ''
      const contents = [...objects.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([name, object]) =>
            `<Contents><Key>${escapeXml(name)}</Key><LastModified>${object.modified.toISOString()}</LastModified><Size>${object.bytes.length}</Size></Contents>`,
        )
        .join('')
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          xml(
            `<ListBucketResult><Name>${MOCK_BUCKET}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${objects.size}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
          ),
        )
      return
    }
    switch (req.method) {
      case 'PUT':
        objects.set(key, {
          bytes: body,
          type: String(req.headers['content-type'] ?? 'application/octet-stream'),
          modified: new Date(),
        })
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` }).end()
        return
      case 'DELETE':
        objects.delete(key)
        res.writeHead(204).end()
        return
      case 'GET':
      case 'HEAD':
        respondObject(req, res, objects.get(key))
        return
      default:
        res.writeHead(405).end()
    }
  })
}

export async function startMockUpstream(): Promise<MockUpstream> {
  const state = { behavior: { ...DEFAULT_BEHAVIOR }, log: [] as RecordedRequest[], inflight: 0 }
  const objects = new Map<string, StoredObject>()
  const images = startImageUpstream(state)
  const store = startObjectStore(objects)
  const [imagePort, storePort] = await Promise.all([listen(images), listen(store)])
  const closeServer = (server: Server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return {
    url: `http://127.0.0.1:${imagePort}`,
    s3Url: `http://127.0.0.1:${storePort}`,
    bucket: MOCK_BUCKET,
    requests: () => [...state.log],
    imageRequests: () => state.log.filter((request) => request.kind !== 'other'),
    inflight: () => state.inflight,
    settle: async (timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (state.inflight > 0) {
        if (Date.now() > deadline)
          throw new Error(`${state.inflight} upstream request(s) still in flight`)
        await sleep(50)
      }
    },
    configure: (next) => {
      Object.assign(state.behavior, next)
    },
    reset: () => {
      state.log.length = 0
      Object.assign(state.behavior, DEFAULT_BEHAVIOR)
    },
    close: async () => {
      await Promise.all([closeServer(images), closeServer(store)])
    },
  }
}
