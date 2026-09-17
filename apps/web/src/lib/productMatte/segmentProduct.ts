import { describeError, i18next } from '../../i18n'
import { eligibleBackends, type MatteBackend, type MatteBackendId } from './backends'
import { logMatteFailure } from './matteLog'
import type { ProductAlpha } from './types'

/** 浏览器回落链自己能给出的失败原因。 */
export type SegmentFailureReason = 'unsupported' | 'timeout' | 'failed'

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
  const timeout = new ProductMatteError(
    'timeout',
    i18next.t('matte.timeout', { ns: 'lib', backend: backend.id }),
  )
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
    throw new ProductMatteError('unsupported', i18next.t('matte.unsupported', { ns: 'lib' }))
  }

  const run = options.run ?? (await import('./segmentWorkerClient')).runInWorker
  let failure = new ProductMatteError('failed', i18next.t('matte.localFailed', { ns: 'lib' }))

  for (const backend of chain) {
    const startedAt = Date.now()
    try {
      const matte = await runWithTimeout(run, backend, dataUrl)
      return { ...matte, backend: backend.id, elapsedMs: Date.now() - startedAt }
    } catch (error) {
      failure =
        error instanceof ProductMatteError
          ? error
          : // worker 里的报错是不翻译的英文技术串（那边不引 i18n，否则整份语料会被打进 worker
            // chunk）。它会一路兜到界面上，所以在这里套一层译文，别让中文用户看到英文。
            new ProductMatteError(
              'failed',
              i18next.t('matte.localFailedWithReason', {
                ns: 'lib',
                reason: describeError(error),
              }),
            )
      logMatteFailure({
        backend: backend.id,
        reason: failure.reason,
        elapsedMs: Date.now() - startedAt,
        error: failure,
      })
    }
  }

  throw failure
}
