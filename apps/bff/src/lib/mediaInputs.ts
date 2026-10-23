import { and, eq, inArray, isNotNull, like } from 'drizzle-orm'
import sharp from 'sharp'
import { config } from '../config'
import { db, schema } from '../db/client'
import { durableMediaStore } from './durableMediaStore'
import { log } from './logger'
import { ObjectStoreHttpError } from './objectStore'

/** 提交里按云媒体身份给的输入图：`aip-media:<media_objects.id>`。 */
export const MEDIA_INPUT_PATTERN = '^aip-media:[0-9a-f-]{36}$'
const MEDIA_INPUT = /^aip-media:([0-9a-f-]{36})$/i

// 与前端 `compressInputImage` 同一口径：长边 2048，小于 256KB 且上游认得的格式原样放行。
const MAX_EDGE = 2048
const PASSTHROUGH_BYTES = 256 * 1024
const UPSTREAM_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const LOAD_CONCURRENCY = 3
// 对象存储读一张输入图的单次期限与次数。Bun 的 S3 读取本身没有超时、遇 5xx 也不重试：
// 2026-10-23 test 桶在 R2 内部错误期间，提交请求被挂住 5～8 分钟才返回。两次各 15 秒，最坏约 30 秒给出明确失败。
const READ_ATTEMPTS = 2
const READ_RETRY_DELAY_MS = 200
let readAttemptTimeoutMs = 15_000

/** 测试用：把单次读取期限调短，免得用例真等 15 秒。不传恢复默认值。 */
export function setMediaInputReadTimeoutForTesting(ms?: number) {
  readAttemptTimeoutMs = ms ?? 15_000
}

export class MediaInputError extends Error {}

function dataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
}

async function compressed(bytes: Uint8Array, contentType: string): Promise<string> {
  const upstream = UPSTREAM_TYPES.has(contentType)
  if (upstream && bytes.length <= PASSTHROUGH_BYTES) return dataUrl(bytes, contentType)
  try {
    const image = sharp(bytes, { failOn: 'warning' }).rotate()
    const metadata = await image.metadata()
    const resized = image.resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    const alpha = contentType !== 'image/jpeg' && Boolean(metadata.hasAlpha)
    const output = alpha
      ? await resized.png().toBuffer()
      : await resized.jpeg({ quality: 85 }).toBuffer()
    if (!upstream || output.length < bytes.length)
      return dataUrl(output, alpha ? 'image/png' : 'image/jpeg')
  } catch {
    if (!upstream) throw new MediaInputError('输入图片无法解码')
  }
  return dataUrl(bytes, contentType)
}

/**
 * 把按媒体身份给的输入图在服务端换成 data URL，后面的归档、计价、上游调用一概不变。
 * 字节从对象存储直接读，不再经浏览器下载一遍再整份 base64 传上来。媒体必须属于这个用户、
 * 已就绪且是图片。带遮罩时不缩放：原生遮罩要求与主图同尺寸。
 */
export async function resolveMediaInputs(
  userId: string | null,
  inputs: readonly string[] | undefined,
  options: {
    readonly masked: boolean
    /** 请求自己的取消信号：客户端断开后不再替它等对象存储。 */
    readonly signal?: AbortSignal
  },
): Promise<string[] | undefined> {
  if (!inputs?.some((input) => MEDIA_INPUT.test(input))) return inputs ? [...inputs] : inputs
  if (!userId) throw new MediaInputError('按媒体引用输入图需要登录')
  const ids = [
    ...new Set(inputs.flatMap((input) => MEDIA_INPUT.exec(input)?.[1]?.toLowerCase() ?? [])),
  ]
  const rows = await db
    .select({
      id: schema.media_objects.id,
      key: schema.media_objects.object_key,
      contentType: schema.media_objects.content_type,
      bytes: schema.media_objects.bytes,
    })
    .from(schema.media_objects)
    .where(
      and(
        inArray(schema.media_objects.id, ids),
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
        isNotNull(schema.media_objects.object_key),
        like(schema.media_objects.content_type, 'image/%'),
      ),
    )
  const found = new Map(rows.map((row) => [row.id.toLowerCase(), row]))
  const resolved = new Map<string, Promise<string>>()
  const load = (id: string) => {
    const row = found.get(id)
    if (!row?.key) throw new MediaInputError('输入图片不存在或无权访问')
    if (row.bytes > config.operator.quotas['sync:asset-image-bytes'])
      throw new MediaInputError('输入图片过大')
    const key = row.key
    return readInput(id, key, options.signal).then((bytes) =>
      options.masked ? exact(bytes, row.contentType) : compressed(bytes, row.contentType),
    )
  }
  // 先确权，再按固定并发读取：16 张大图同时解码会占满内存，逐张串行又把延迟叠起来。
  for (const id of ids)
    if (!found.get(id)?.key) throw new MediaInputError('输入图片不存在或无权访问')
  const queue = [...ids]
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const pending = load(id)
      resolved.set(id, pending)
      await pending
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, ids.length) }, worker))
  return Promise.all(
    inputs.map((input) => {
      const id = MEDIA_INPUT.exec(input)?.[1]?.toLowerCase()
      return id ? resolved.get(id)! : input
    }),
  )
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function storageStatus(error: unknown): number | string | undefined {
  if (error instanceof ObjectStoreHttpError) return error.status
  // 超时/取消的 DOMException 也带数字 code（如 23），那不是对象存储给的状态，记名字。
  if (error instanceof DOMException) return error.name
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

/**
 * 每次尝试都有期限，且跟随请求取消；读不到就把对象键、状态码和原始异常记进日志再抛，
 * 不再只剩一句「读取输入图片失败」。4xx 与客户端已断开不重试。
 */
async function readInput(
  mediaId: string,
  key: string,
  requestSignal: AbortSignal | undefined,
): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(readAttemptTimeoutMs)
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout
    const started = performance.now()
    try {
      return await abortable(durableMediaStore().read(key, signal), signal)
    } catch (error) {
      const clientGone = Boolean(requestSignal?.aborted)
      const status = storageStatus(error)
      const clientError = typeof status === 'number' && status >= 400 && status < 500
      const retry = !clientGone && !clientError && attempt < READ_ATTEMPTS
      log.warn(
        {
          event: 'media_input.read_failed',
          mediaId,
          objectKey: key,
          attempt,
          elapsedMs: Math.round(performance.now() - started),
          timedOut: timeout.aborted,
          clientGone,
          storageStatus: status,
          willRetry: retry,
          err: error,
        },
        'input image read from object storage failed',
      )
      if (!retry) throw error
      await Bun.sleep(READ_RETRY_DELAY_MS)
    }
  }
}

/** 带遮罩：尺寸不能动；上游不认的格式按原尺寸转 PNG（保留 alpha）。 */
async function exact(bytes: Uint8Array, contentType: string): Promise<string> {
  if (UPSTREAM_TYPES.has(contentType)) return dataUrl(bytes, contentType)
  try {
    return dataUrl(await sharp(bytes, { failOn: 'warning' }).png().toBuffer(), 'image/png')
  } catch {
    throw new MediaInputError('输入图片无法解码')
  }
}
