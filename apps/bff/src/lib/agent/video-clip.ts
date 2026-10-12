import { parseProjectArtifactId } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { durableMediaStore } from '../durableMediaStore'
import { resolveImageBytesRef } from '../extractImages'
import { fetchSourceImage, SourceImageFetchError } from '../imageArchive'
import { log } from '../logger'
import { objectStore, readObjectWithinLimit } from '../objectStore'
import { asQueueProvider, isAbortError } from '../queueProvider'
import { SafeFetchError } from '../safeFetch'
import { taskAccessWhere } from '../task-access'
import type { AgentToolContext } from './tools/types'

const POSTER_ID = /^(?:aip-media:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const POSTER = '这是封面图片 id，看视频请用视频 id。'
const NOT_ID = '这不是视频 id。看视频请用结果里的视频 id。'
const MISSING = '找不到这段视频。'
const PENDING = '这段视频还没出完，出完后再看。'
const NOT_VIDEO = '这个产物不是视频。'
const TOO_LARGE = '这段视频太大，读不了画面。'
const UNREADABLE = '这段视频暂时读不到，请稍后再试。'

export type VideoClip =
  | {
      readonly ok: true
      readonly videoId: string
      readonly bytes: Uint8Array
      readonly mime: string
      readonly durationSeconds?: number
    }
  | { readonly ok: false; readonly message: string }

type VideoClipReader = (
  context: AgentToolContext,
  videoId: string,
  signal?: AbortSignal,
) => Promise<VideoClip>

function videoByteCap(): number | undefined {
  const limit = config.operator.quotas['sync:asset-image-bytes']
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
}

function durationAt(payload: unknown, index: number): number | undefined {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return undefined
  let count = 0
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const present =
      (typeof record.b64_json === 'string' && record.b64_json.length > 0) ||
      (typeof record.object === 'string' && record.object.length > 0) ||
      (typeof record.url === 'string' && /^https?:\/\//i.test(record.url))
    if (!present) continue
    if (count === index) {
      const seconds = record.duration_seconds
      return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? seconds
        : undefined
    }
    count += 1
  }
  return undefined
}

function readFailure(error: unknown, videoId: string): VideoClip {
  log.warn({ err: error, event: 'agent.video_clip_failed', videoId }, 'viewVideo clip read failed')
  if (error instanceof SafeFetchError && error.code === 'too_large')
    return { ok: false, message: TOO_LARGE }
  if (error instanceof SourceImageFetchError && error.message.includes('exceeds size limit'))
    return { ok: false, message: TOO_LARGE }
  return { ok: false, message: UNREADABLE }
}

/**
 * 只读本会话已完成的视频产物。封面 uuid 与别人的任务都在进字节之前挡住；
 * 找不到和不是这个会话的，对模型说同一句话。
 */
async function readStoredVideo(
  context: AgentToolContext,
  rawId: string,
  signal?: AbortSignal,
): Promise<VideoClip> {
  const videoId = rawId.trim()
  if (POSTER_ID.test(videoId)) return { ok: false, message: POSTER }
  const parsed = parseProjectArtifactId(videoId)
  if (!parsed) return { ok: false, message: NOT_ID }
  signal?.throwIfAborted()
  const [task] = await db
    .select({
      status: schema.tasks.status,
      provider: schema.tasks.provider,
      result_payload: schema.tasks.result_payload,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.agent_conversation_id, context.conversationId),
        taskAccessWhere(parsed.generationId, context.userId),
      ),
    )
    .limit(1)
  if (!task) return { ok: false, message: MISSING }
  if (task.status !== 'completed') return { ok: false, message: PENDING }
  const provider = asQueueProvider(task.provider)
  const ref = provider ? resolveImageBytesRef(provider, task.result_payload, parsed.position) : null
  if (!ref) return { ok: false, message: MISSING }
  if (!ref.mime.startsWith('video/')) return { ok: false, message: NOT_VIDEO }
  const cap = videoByteCap()
  if (cap === undefined) return { ok: false, message: UNREADABLE }
  signal?.throwIfAborted()
  try {
    const bytes = await videoBytes(ref, cap, signal)
    if (bytes.byteLength === 0) return { ok: false, message: UNREADABLE }
    const durationSeconds = durationAt(task.result_payload, parsed.position)
    return {
      ok: true,
      videoId,
      bytes,
      mime: ref.mime,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    }
  } catch (error) {
    // 取消要冒出去，准备槽的 finally 才能马上放开。下载层会把中止包成别的错误，
    // 这里认的是调用方的信号，不把「读不到」交回模型。
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error
    if (isAbortError(error)) throw error
    return readFailure(error, videoId)
  }
}

async function videoBytes(
  ref: NonNullable<ReturnType<typeof resolveImageBytesRef>>,
  cap: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  if (ref.kind === 'b64') {
    if (Math.ceil((ref.data.length * 3) / 4) > cap) throw new SafeFetchError('too_large', TOO_LARGE)
    const bytes = Buffer.from(ref.data, 'base64')
    if (bytes.byteLength > cap) throw new SafeFetchError('too_large', TOO_LARGE)
    return bytes
  }
  if (ref.kind === 'object') {
    return readObjectWithinLimit(
      ref.store === 'durable' ? durableMediaStore() : objectStore(),
      ref.data,
      cap,
      signal,
    )
  }
  return (await fetchSourceImage(ref.data, { maxBytes: cap, signal })).bytes
}

let reader: VideoClipReader = readStoredVideo

/** 测试注入片子字节。传 null 恢复真的读取。 */
export function setVideoClipReaderForTesting(next: VideoClipReader | null): void {
  reader = next ?? readStoredVideo
}

export function readVideoClip(
  context: AgentToolContext,
  videoId: string,
  signal?: AbortSignal,
): Promise<VideoClip> {
  return reader(context, videoId, signal)
}
