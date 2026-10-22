import { nearestImageSize } from '@image-playground/shared'
import type { HydratedSubmitRequest } from '../imageArchive'
import { buildGeminiBody } from './gemini'
import { clientError } from './shared'

/*
 * Vertex AI（Agent Platform）直连 Gemini 图像模型的兼容性收口。请求体与网关 Gemini 是同一份
 * generateContent（`buildGeminiBody`），这里只处理上游实测会 400 的参数组合，别把它扩成字段翻译。
 *
 * 2026-10-22 在 global 端点实测：
 * - gemini-3.1-flash-lite-image 只出 1K，带 imageSize 2K / 512 一律 400 invalid argument；
 * - gemini-nano-banana-2.1 与 gemini-3-pro-image 认 1K / 2K（及 4K），512 一律 400；
 * - 三者都认 thinkingLevel minimal / high。
 * 每个模型认哪几档写在 channels.json 的 `imageSizes`（4K 还没分档定价，暂不开放）。
 */

/** Gemini 3 系图像模型单次最多 14 张参考图（官方上限）；超出时上游 400，提交前就拦下并说清楚。 */
export const VERTEX_MAX_INPUT_IMAGES = 14

/**
 * 构造发往 Vertex 的 generateContent 请求体，并在发出前收口实测会 400 的组合。
 *
 * 分辨率看的是 `buildGeminiBody` 产出的最终 `generationConfig.imageConfig.imageSize`，而不是扁平的
 * `image_size`：`extra.generationConfig` 会整段压过扁平参数推导的配置，只有最终值才是上游真正
 * 收到的。模型不认的档位（共享档位里的 512、Lite 的 2K、面板没开放的 4K、旧任务重试带的值）换成
 * 渠道声明里最近的一档（`nearestImageSize`），不让整单失败；计费按张不变，任务里记的仍是原值，
 * 这是有意的兼容取舍。显式给了却不是对象的 imageConfig 仍当无效配置拒绝。
 */
export function buildVertexBody(
  request: HydratedSubmitRequest,
  imageSizes: readonly string[] | undefined,
): Record<string, unknown> {
  if ((request.input_images?.length ?? 0) > VERTEX_MAX_INPUT_IMAGES)
    throw clientError(`该模型最多接受 ${VERTEX_MAX_INPUT_IMAGES} 张参考图，请减少参考图后重试`)
  const body = buildGeminiBody(request)
  const generationConfig = body.generationConfig as Record<string, unknown>
  // 实测 candidateCount=2 一律 400：多张由调用方拆成单张请求发（见 upstream.ts 的 fan-out），
  // extra 里带进来的 candidateCount 只能是 1。
  const candidateCount = generationConfig.candidateCount
  if (candidateCount !== undefined && candidateCount !== 1)
    throw clientError('该模型每次请求只出一张图，多张请用「张数」设置')
  if (!imageSizes?.length) return body
  const imageConfig = generationConfig.imageConfig
  if (imageConfig === undefined) return body
  if (imageConfig === null || typeof imageConfig !== 'object' || Array.isArray(imageConfig))
    throw clientError('分辨率配置无效，请改用面板里的分辨率选项后重试')
  const size = (imageConfig as { imageSize?: unknown }).imageSize
  if (size === undefined) return body
  const supported = nearestImageSize(size, imageSizes)
  if (supported === size) return body
  return {
    ...body,
    generationConfig: {
      ...generationConfig,
      imageConfig: { ...imageConfig, imageSize: supported },
    },
  }
}

/**
 * 单条 generateContent 遇到 429 时在请求内的退避（毫秒），用完还是 429 就交给任务级重试
 * （retry.ts，10 秒 / 30 秒后整单再跑）。
 *
 * 2026-10-22 22:23–22:29 用生产同一个 key 在 global 端点实测（1K 1:1、不重试）：三个模型各自
 * 只能连着放过 2–3 条，再来的请求 0.1–0.2 秒就回 RESOURCE_EXHAUSTED；之后大约每 40–50 秒才再
 * 放过一条（Lite 每 12 秒发一条，8 条里过了 3 条）。限的是到达速率而不是在途条数，而且按模型各算各的。
 * 官方说明（Standard PayGo）：这类 429 不是固定配额，是共享资源争用，建议指数退避、把请求摊平，
 * 不要秒级扎堆。所以这里按 5 / 15 / 30 秒（±25% 抖动）退避，退避期间继续占着排队位，
 * 同一模型后面的请求跟着排队，正好起到摊平的作用。
 */
export const VERTEX_RATE_LIMIT_BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000]

let rateLimitBackoffMs = VERTEX_RATE_LIMIT_BACKOFF_MS

/** 测试注入点；undefined 恢复真实退避。 */
export function setVertexRateLimitBackoffForTesting(backoffMs?: readonly number[]): void {
  rateLimitBackoffMs = backoffMs ?? VERTEX_RATE_LIMIT_BACKOFF_MS
}

function isRateLimited(error: unknown): boolean {
  return (error as { upstreamStatus?: unknown } | null)?.upstreamStatus === 429
}

/**
 * 发一条 Vertex 请求，429 时按 `VERTEX_RATE_LIMIT_BACKOFF_MS` 退避重发。429 是上游没受理的明确
 * 答复，重发不会重复出图。退避用完、或退避途中任务到点，都抛出一个仍带 429 的错误
 * （任务级重试照旧接手），文案说清楚是上游限流；任务失败时冻结的积分按现有结算退回。
 */
export async function withVertexRateLimitRetry<T>(
  send: () => Promise<T>,
  signal: AbortSignal,
  isTimeout: () => boolean,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send()
    } catch (error) {
      if (!isRateLimited(error)) throw error
      const delay = rateLimitBackoffMs[attempt]
      if (delay === undefined) throw rateLimitedError(error)
      try {
        await sleep(delay * (0.75 + Math.random() * 0.5), signal)
      } catch (abort) {
        // 到点：这条请求上游没受理过，按限流失败报，别冒充「结果未知」。用户取消照旧往外抛。
        if (isTimeout()) throw rateLimitedError(error)
        throw abort
      }
    }
  }
}

function rateLimitedError(cause: unknown): Error {
  const err = new Error('Nano Banana 当前请求太多（上游限流），已自动重试仍未成功，请稍后再试', {
    cause,
  }) as Error & { upstreamStatus: number; upstreamPayload?: unknown }
  err.upstreamStatus = 429
  // 原始响应体留给失败记录（errors.ts 的 extractUpstreamFailure），排障时看得到上游原话。
  const payload = (cause as { upstreamPayload?: unknown } | null)?.upstreamPayload
  if (payload !== undefined) err.upstreamPayload = payload
  return err
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
