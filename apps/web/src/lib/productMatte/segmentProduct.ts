import { eligibleBackends, type MatteBackend, type MatteBackendId } from './backends'
import type { ProductAlpha } from './types'

export type SegmentFailureReason = 'unsupported' | 'timeout' | 'failed'

export const MATTE_FAILURE_LABELS: Record<SegmentFailureReason, string> = {
  timeout: '超时',
  unsupported: '不支持',
  failed: '运行错误',
}

export class ProductMatteError extends Error {
  readonly reason: SegmentFailureReason

  constructor(reason: SegmentFailureReason, message: string) {
    super(message)
    this.name = 'ProductMatteError'
    this.reason = reason
  }
}

export type MatteRunner = (
  backend: MatteBackend,
  dataUrl: string,
  signal: AbortSignal,
) => Promise<ProductAlpha>

export interface SegmentProductOptions {
  backends?: readonly MatteBackend[]
  run?: MatteRunner
}

export interface SegmentedProduct extends ProductAlpha {
  backend: MatteBackendId
  elapsedMs: number
}

/** 超时由这里判，不等后端自己认账：卡死的 worker 不能把整条链拖住。 */
function runWithTimeout(
  run: MatteRunner,
  backend: MatteBackend,
  dataUrl: string,
): Promise<ProductAlpha> {
  const controller = new AbortController()
  const timeout = new ProductMatteError('timeout', `${backend.id} 抠图超时`)
  let timer: ReturnType<typeof setTimeout>
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeout)
      reject(timeout)
    }, backend.timeoutMs)
  })
  return Promise.race([run(backend, dataUrl, controller.signal), expired]).finally(() =>
    clearTimeout(timer),
  )
}

/** 沿回落链一环环试，第一个抠出来的就是答案；全挂了抛最后一环的原因。 */
export async function segmentProduct(
  dataUrl: string,
  options: SegmentProductOptions = {},
): Promise<SegmentedProduct> {
  const chain = await eligibleBackends(options.backends)
  if (chain.length === 0) {
    throw new ProductMatteError('unsupported', '当前浏览器跑不了本地抠图')
  }

  const run = options.run ?? (await import('./segmentWorkerClient')).runInWorker
  let failure = new ProductMatteError('failed', '本地抠图失败')

  for (const backend of chain) {
    const startedAt = Date.now()
    try {
      const matte = await runWithTimeout(run, backend, dataUrl)
      return { ...matte, backend: backend.id, elapsedMs: Date.now() - startedAt }
    } catch (error) {
      failure =
        error instanceof ProductMatteError
          ? error
          : new ProductMatteError('failed', error instanceof Error ? error.message : String(error))
    }
  }

  throw failure
}
