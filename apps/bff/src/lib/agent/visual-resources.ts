import { AsyncLocalStorage } from 'node:async_hooks'
import sharp from 'sharp'
import { config } from '../../config'
import { SafeFetchError } from '../safeFetch'
import { AgentToolError } from './tools/errors'

const preparation = new AsyncLocalStorage<boolean>()
let active = 0
const waiting: (() => void)[] = []
const signals = new AsyncLocalStorage<AbortSignal | undefined>()

/** Propagate tool cancellation without holding a preparation slot during long-running tools. */
export function withVisualSignal<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return signals.run(signal, work)
}

async function acquire(limit: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (active < limit) {
    active++
    return
  }
  const queueLimit = config.operator.quotas['agent:visual-prepare-queue']
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1)
    throw new AgentToolError('invalid_params', '图片准备队列配置无效，请联系运营人员。')
  if (waiting.length >= queueLimit)
    throw new AgentToolError('quota_exceeded', '图片准备队列已满，本次图片尚未读取；请稍后重试。')
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      const index = waiting.indexOf(ready)
      if (index >= 0) waiting.splice(index, 1)
      reject(signal?.reason)
    }
    const ready = () => {
      signal?.removeEventListener('abort', cancel)
      active++
      resolve()
    }
    waiting.push(ready)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

/** One slot covers reading and its derived buffers; nested image operations share the slot. */
export async function withVisualPreparation<T>(
  work: () => Promise<T>,
  signal = signals.getStore(),
): Promise<T> {
  signal?.throwIfAborted()
  if (preparation.getStore()) return work()
  const limit = config.operator.quotas['agent:visual-prepare-concurrency']
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new AgentToolError('invalid_params', '图片准备并发配置无效，请联系运营人员。')
  await acquire(limit, signal)
  try {
    signal?.throwIfAborted()
    return await preparation.run(true, work)
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === 'too_large')
      throw new AgentToolError(
        'quota_exceeded',
        `${error.message}；本次图片未完整读取，未送入模型，联合比较尚未完成。请选择必要区域或缩小共同查看范围。`,
      )
    throw error
  } finally {
    active -= 1
    waiting.shift()?.()
  }
}

export function visualPixelLimit(): number {
  const limit = config.operator.quotas['agent:visual-max-pixels']
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new AgentToolError('invalid_params', '图片像素预算配置无效，请联系运营人员。')
  return limit
}

export async function visualMetadata(bytes: Uint8Array) {
  const limit = visualPixelLimit()
  try {
    const metadata = await sharp(bytes, { limitInputPixels: limit }).metadata()
    const pixels = (metadata.width ?? 0) * (metadata.height ?? 0) * (metadata.pages ?? 1)
    if (pixels > limit)
      throw new AgentToolError(
        'invalid_params',
        `图片需要 ${pixels} 像素，超过当前准备预算 ${limit}；未静默缩小图片。请选择需要的区域或重新添加符合预算的图片。`,
      )
    if (!metadata.width || !metadata.height) throw new Error('missing dimensions')
    return metadata
  } catch (error) {
    if (error instanceof AgentToolError) throw error
    throw new AgentToolError(
      'invalid_params',
      `图片无法在 ${limit} 像素预算内安全读取。请选择需要的区域或重新添加有效图片。`,
    )
  }
}

export function visualByteLimit(): number {
  const limit = config.operator.quotas['agent:request-max-bytes']
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new AgentToolError('invalid_params', '图片字节预算配置无效，请联系运营人员。')
  return limit
}

export function assertVisualBytes(bytes: number): void {
  const limit = visualByteLimit()
  if (!Number.isSafeInteger(limit) || limit < 1 || bytes > limit)
    throw new AgentToolError(
      'quota_exceeded',
      `图片需要 ${bytes} 字节，超过当前准备预算 ${limit}；本次图片未送入模型，联合比较尚未完成。请选择必要区域或缩小共同查看范围，不能以逐图摘要代替完整联合比较。`,
    )
}
