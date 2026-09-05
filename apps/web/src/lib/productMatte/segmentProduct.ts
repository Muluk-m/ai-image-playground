import type { ProductAlpha } from './types'

export const DEFAULT_SEGMENT_TIMEOUT_MS = 60_000

export type SegmentFailureReason = 'unsupported' | 'timeout' | 'failed'

export class ProductMatteError extends Error {
  readonly reason: SegmentFailureReason

  constructor(reason: SegmentFailureReason, message: string) {
    super(message)
    this.name = 'ProductMatteError'
    this.reason = reason
  }
}

export interface SegmentProductOptions {
  timeoutMs?: number
}

/**
 * 只走 WebGPU：唯一体积可接受的权重是 fp16，而 fp16 在 wasm 后端没有可靠支持；
 * 没有 WebGPU 就直接失败，让调用方回落提示词版，不去下 200 MB 的 fp32。
 */
export function isProductMatteSupported(): boolean {
  if (typeof navigator === 'undefined') return false
  return Boolean((navigator as { gpu?: unknown }).gpu)
}

export async function segmentProduct(
  dataUrl: string,
  options: SegmentProductOptions = {},
): Promise<ProductAlpha> {
  if (!isProductMatteSupported()) {
    throw new ProductMatteError('unsupported', '当前浏览器不支持本地抠图（需要 WebGPU）')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_SEGMENT_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const segmented = import('./segmentEngine').then((engine) =>
      engine.runProductSegmentation(dataUrl),
    )
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProductMatteError('timeout', '抠图超时')), timeoutMs)
    })
    return await Promise.race([segmented, timedOut])
  } catch (error) {
    if (error instanceof ProductMatteError) throw error
    throw new ProductMatteError('failed', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}
