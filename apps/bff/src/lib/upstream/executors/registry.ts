import { adaptGptRequest } from '../adapters'
import { type ConcurrencyGate, getConcurrencyGate } from '../concurrency'
import { withoutModeration } from '../openai'
import type { UpstreamRoute } from '../routes'
import type { UpstreamCallResult } from '../shared'
import { createUpstreamSession } from '../transport'
import type { AttemptOptions, UpstreamCallParams } from '../types'
import { geminiImageExecutor } from './gemini-image'
import { openaiCompatImageExecutor } from './openai-compat-image'
import type { UpstreamExecutionContext, UpstreamExecutor } from './types'
import { videoUpstreamExecutor } from './video'

export type { UpstreamExecutionContext, UpstreamExecutor } from './types'

export class UpstreamRegistry {
  private readonly executors: UpstreamExecutor[] = []

  constructor(initial: readonly UpstreamExecutor[] = []) {
    for (const executor of initial) this.register(executor)
  }

  register(executor: UpstreamExecutor): void {
    const existing = this.executors.findIndex((item) => item.id === executor.id)
    if (existing >= 0) this.executors[existing] = executor
    else this.executors.push(executor)
  }

  resolve(ctx: Pick<UpstreamExecutionContext, 'params' | 'route'>): UpstreamExecutor | undefined {
    return this.executors.find((executor) => executor.matches(ctx))
  }

  list(): readonly UpstreamExecutor[] {
    return this.executors
  }
}

export const defaultUpstreamRegistry = new UpstreamRegistry([
  videoUpstreamExecutor,
  openaiCompatImageExecutor,
  geminiImageExecutor,
])

export async function executeViaRoute(
  params: UpstreamCallParams,
  route: UpstreamRoute,
  attempt: AttemptOptions = {},
  options: {
    readonly registry?: UpstreamRegistry
    readonly concurrencyGate?: ConcurrencyGate
  } = {},
): Promise<UpstreamCallResult> {
  const { provider, model } = params
  const { style, forceB64Json, supportsModeration, supportsNativeN, gptRoute } = route
  let request = gptRoute ? adaptGptRequest(gptRoute, model, params.request) : params.request
  // 原生 n 只适用于无参考图的 Images generations；Responses 图片工具不接受 tools[].n。
  const requestedImageCount = Math.max(1, request.n ?? 1)
  const useNativeN =
    provider === 'openai-compat' &&
    style === 'openai-images' &&
    supportsNativeN &&
    requestedImageCount > 1 &&
    !request.input_images?.length &&
    !request.mask
  // Grok 回的 imgen.x.ai URL 对服务器出口 IP 一律 403（带 Bearer 也 403），归档取不到图。
  if (forceB64Json) {
    request = { ...request, extra: { ...request.extra, response_format: 'b64_json' } }
  }
  if (!supportsModeration) request = withoutModeration(request)

  const initialImagesPerDispatch = useNativeN ? requestedImageCount : 1
  const session = createUpstreamSession(params, route, attempt, initialImagesPerDispatch)
  const registry = options.registry ?? defaultUpstreamRegistry
  const concurrencyGate = options.concurrencyGate ?? getConcurrencyGate()

  // 这个 try 里必须 `return await`：裸 return 一个 promise 会让下面的 finally 立刻跑，
  // 请求还在飞的时候就 release 掉 deadline —— 取消与硬超时都会静默失效。
  try {
    const executor = registry.resolve({ params, route })
    if (!executor) throw new Error(`Unsupported provider: ${provider}`)
    return await executor.execute({
      params,
      route,
      request,
      useNativeN,
      session,
      concurrencyGate,
    })
  } catch (err) {
    // fan-out 请求任一失败时取消其它同批请求，避免 callUpstream 已返回失败后仍在后台跑。
    session.abort()
    throw err
  } finally {
    await session.cleanup()
  }
}
