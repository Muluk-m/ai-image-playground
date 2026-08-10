import { File } from 'node:buffer'
import { QUEUE_TIMEOUTS, type QueueProvider } from '@image-playground/shared'
import { Agent, FormData, fetch as undiciFetch } from 'undici'
import { config } from '../config'
import { getChannels } from './channels'
import type { HydratedSubmitRequest } from './imageArchive'
import { log } from './logger'
import { resolveApiKey } from './resolveApiKey'

/**
 * 把 SubmitRequest 转换为 OpenAI Images / Gemini generateContent 请求体并发给上游 API。
 *
 * BFF 不做参数翻译；OpenAI 路径根据是否带 input_images 选 images/edits（multipart）
 * 或 images/generations（JSON），Gemini 路径走 models/{model}:generateContent。
 *
 * 同机部署时 upstream 是 localhost，无 Edge / 跨网延迟。这里仍设硬超时
 * (QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS)，防止上游卡死时 BFF worker
 * 永远 hang、task 永远停在 in_progress。
 */
/**
 * 独立直连上游的 channel id。命中的 channel 用 channels.json 自带的
 * baseUrl + auth.secret（单一事实源），不走 UPSTREAM_BASE_URL 通用网关。
 *
 * 不能按 model 盲查 channels：网关部署用 UPSTREAM_BASE_URL 故意把
 * openai/gemini channel 指到同一中转上游，channels.json 里它们的 baseUrl
 * 只是名义官方地址，盲查会把网关部署静默切成直连。
 */
const DIRECT_CHANNEL_IDS: ReadonlySet<string> = new Set(['agnes-images'])

/**
 * provider + model → 上游 baseUrl 与 API key。
 * 返回的 baseUrl 统一**含版本段**（如 .../v1、.../v1beta），调用方拼相对路径，
 * 杜绝 channel baseUrl（含版本段）与 env baseUrl（不含）两套约定打架拼出 /v1/v1。
 * `direct=true` 表示命中独立直连 channel（Agnes 风格上游，见 callUpstream 内分支）。
 */
function resolveUpstream(
  provider: QueueProvider,
  model: string,
): { baseUrl: string; key: string; direct: boolean } {
  const kind = provider === 'gemini' ? 'gemini-queue' : 'openai-queue'
  const channel = getChannels().find(
    (c) => c.kind === kind && DIRECT_CHANNEL_IDS.has(c.id) && c.models.some((m) => m.id === model),
  )
  if (channel) return { baseUrl: channel.baseUrl, key: channel.auth.secret, direct: true }
  const version = provider === 'gemini' ? 'v1beta' : 'v1'
  return {
    baseUrl: `${config.upstream.baseUrl}/${version}`,
    key: resolveApiKey(provider),
    direct: false,
  }
}
export interface UpstreamCallParams {
  provider: QueueProvider
  model: string
  request: HydratedSubmitRequest
  signal?: AbortSignal
  /** Runs immediately before each HTTP request is dispatched. */
  beforeRequest?: () => Promise<void>
}

export interface UpstreamCallResult {
  payload: unknown
}

type UpstreamFetch = typeof undiciFetch
type UpstreamFetchInit = Parameters<UpstreamFetch>[1]
type UpstreamResponse = Awaited<ReturnType<UpstreamFetch>>

export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000
export const UPSTREAM_TRANSPORT_TIMEOUT_MS = QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 60_000

const upstreamDispatcher = new Agent({
  connectTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
  headersTimeout: UPSTREAM_TRANSPORT_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_TRANSPORT_TIMEOUT_MS,
})

let upstreamFetch: UpstreamFetch = undiciFetch

/** 测试注入点；undefined 恢复真实 Undici transport。 */
export function setUpstreamFetchForTesting(fetchImpl?: UpstreamFetch): void {
  upstreamFetch = fetchImpl ?? undiciFetch
}

/**
 * 自定义错误：BFF 自己的 UPSTREAM_HARD_TIMEOUT_MS 切的（vs 上游返 4xx/5xx
 * 或 socket 异常关）。task-runner 用 instanceof 检查并统一落库为
 * `upstream_result_unknown`，避免自动重试重复执行。
 */
export class UpstreamResultUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UpstreamResultUnknownError'
  }
}

export class UpstreamTimeoutError extends UpstreamResultUnknownError {
  constructor(message = 'Upstream call exceeded BFF hard timeout') {
    super(message)
    this.name = 'UpstreamTimeoutError'
  }
}

/**
 * Bun fetch 的 client timeout 无法可靠覆盖，改用 Undici Agent 的公开配置项。
 * transport headers/body 都比应用硬超时长 1min，确保正常终止统一由下方
 * AbortController 决定；不再依赖 undocumented idleTimeout 或强制 Connection: close。
 */
export async function callUpstream(params: UpstreamCallParams): Promise<UpstreamCallResult> {
  const { provider, model, request, signal: externalSignal, beforeRequest } = params
  const { baseUrl: base, key, direct } = resolveUpstream(provider, model)

  const abort = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS)
  const onExternalAbort = () => abort.abort()
  if (externalSignal?.aborted) abort.abort()
  else externalSignal?.addEventListener('abort', onExternalAbort)

  const fetchInit = (init: UpstreamFetchInit): UpstreamFetchInit => ({
    ...init,
    signal: abort.signal,
    dispatcher: upstreamDispatcher,
  })

  const performFetch = async (url: string, init: UpstreamFetchInit): Promise<UpstreamResponse> => {
    try {
      if (abort.signal.aborted) throw new DOMException('Upstream request aborted', 'AbortError')
      await beforeRequest?.()

      // The accounting callback is the dispatch commit point. Start the transport with a fresh
      // signal before relaying cancellation so a cancellation that loses the database race cannot
      // create a charged task without a corresponding upstream invocation.
      const requestAbort = new AbortController()
      const relayAbort = () => requestAbort.abort()
      const responsePromise = upstreamFetch(url, {
        ...fetchInit(init),
        signal: requestAbort.signal,
      })
      abort.signal.addEventListener('abort', relayAbort, { once: true })
      if (abort.signal.aborted) relayAbort()
      try {
        return await responsePromise
      } finally {
        abort.signal.removeEventListener('abort', relayAbort)
      }
    } catch (err) {
      if (timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游连接中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  const parseResponse = async (res: UpstreamResponse): Promise<UpstreamCallResult> => {
    try {
      return await parseUpstreamResponse(res)
    } catch (err) {
      if (timedOut) throw new UpstreamTimeoutError()
      if (externalSignal?.aborted) throw err
      if (typeof (err as { upstreamStatus?: unknown })?.upstreamStatus === 'number') throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new UpstreamResultUnknownError(`上游响应中断，执行结果未知：${detail}`, {
        cause: err,
      })
    }
  }

  try {
    if (provider === 'openai-compat') {
      const authHeader: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}

      // Direct channel（Agnes 风格上游）：没有 images/edits 端点，图生图与文生图
      // 共用 images/generations JSON，输入图放 extra_body.image（data URI / URL）。
      // 实测注意：文档"Important Notes"声称的 top-level image 数组会被上游**静默忽略**
      // （跑成纯文生图），必须放 extra_body；n 同样被忽略，这里学 gemini 分支 fan-out。
      if (direct) {
        if (request.mask) {
          // 挂 upstreamStatus=400 → retry.ts 判为永久失败，不浪费 3 次重试
          const err = new Error(
            '该模型不支持遮罩编辑（上游无 mask 能力），请换 GPT 模型或去掉遮罩',
          ) as Error & { upstreamStatus: number }
          err.upstreamStatus = 400
          throw err
        }
        const url = `${base}/images/generations`
        const body = JSON.stringify(buildDirectChannelBody(model, request))
        const headers = { 'content-type': 'application/json', ...authHeader }
        return fanOutRequests(
          request.n,
          async () => {
            const res = await performFetch(url, { method: 'POST', headers, body })
            return parseResponse(res)
          },
          mergeOpenAIDataResults,
        )
      }

      // 有参考图 / 有遮罩 → images/edits multipart；generations 是纯文生图，
      // 塞 input_images 字段上游会忽略（用户感知"AI 不参考附件"）。
      if (request.input_images?.length || request.mask) {
        const url = `${base}/images/edits`
        const files = prepareOpenAIEditFiles(request)
        return fanOutRequests(
          request.n,
          async () => {
            const res = await performFetch(url, {
              method: 'POST',
              headers: authHeader,
              body: buildOpenAIEditFormData(model, request, files),
            })
            return parseResponse(res)
          },
          mergeOpenAIDataResults,
        )
      }
      const res = await performFetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify(buildOpenAIBody(model, request)),
      })
      return parseResponse(res)
    }

    if (provider === 'gemini') {
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
      const headers = {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
      }
      const body = JSON.stringify(buildGeminiBody(request))

      // Gemini image generation 不支持 candidateCount>1（"Only one candidate is
      // supported for audio or image response"），n>1 时本层 fan-out 成 N 次并发
      // 请求并把 candidates 合并到一个 payload，对 task-runner / 前端透明。
      return fanOutRequests(
        request.n,
        async () => {
          const res = await performFetch(url, { method: 'POST', headers, body })
          return parseResponse(res)
        },
        mergeGeminiCandidateResults,
      )
    }
    throw new Error(`Unsupported provider: ${provider satisfies never}`)
  } catch (err) {
    // fan-out 请求任一失败时取消其它同批请求，避免 callUpstream 已返回失败后仍在后台跑。
    abort.abort()
    throw err
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

async function fanOutRequests(
  requestedCount: number | undefined,
  run: () => Promise<UpstreamCallResult>,
  merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
): Promise<UpstreamCallResult> {
  const count = Math.max(1, requestedCount ?? 1)
  if (count === 1) return run()
  return merge(await Promise.all(Array.from({ length: count }, run)))
}

function mergeGeminiCandidateResults(results: UpstreamCallResult[]): UpstreamCallResult {
  return {
    payload: {
      candidates: results.flatMap((result) => {
        const payload = result.payload as { candidates?: unknown[] } | null
        return Array.isArray(payload?.candidates) ? payload.candidates : []
      }),
    },
  }
}

function mergeOpenAIDataResults(results: UpstreamCallResult[]): UpstreamCallResult {
  const first = results[0]?.payload
  const firstPayload =
    first && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : {}
  return {
    payload: {
      ...firstPayload,
      data: results.flatMap((result) => {
        const payload = result.payload as { data?: unknown[] } | null
        return Array.isArray(payload?.data) ? payload.data : []
      }),
    },
  }
}

/**
 * Direct channel（Agnes 风格）请求体：文生图与图生图同一端点同一 JSON 体，
 * 输入图放 extra_body.image（实测 top-level image 会被上游静默忽略）。
 * quality / n 上游不识别 → 不传（n 由 callUpstream fan-out 实现）。
 * 新增的 OpenAI / Gemini 参数也不传，避免上游拒绝或静默忽略未知字段。
 */
function buildDirectChannelBody(
  model: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  const { extra_body: extraBody, ...extraTop } = (request.extra ?? {}) as {
    extra_body?: Record<string, unknown>
    [k: string]: unknown
  }
  const mergedExtraBody: Record<string, unknown> = { ...(extraBody ?? {}) }
  if (request.input_images?.length) mergedExtraBody.image = request.input_images
  return {
    model,
    prompt: request.prompt,
    ...(request.size ? { size: request.size } : {}),
    ...extraTop,
    ...(Object.keys(mergedExtraBody).length ? { extra_body: mergedExtraBody } : {}),
  }
}

function buildOpenAIBody(model: string, request: HydratedSubmitRequest): Record<string, unknown> {
  return {
    model,
    prompt: request.prompt,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.output_format ? { output_format: request.output_format } : {}),
    ...(request.moderation ? { moderation: request.moderation } : {}),
    ...(request.output_compression != null
      ? { output_compression: request.output_compression }
      : {}),
    ...(request.n ? { n: request.n } : {}),
    ...(request.extra ?? {}),
  }
}

interface OpenAIEditFiles {
  inputs: File[]
  mask?: File
}

function prepareOpenAIEditFiles(request: HydratedSubmitRequest): OpenAIEditFiles {
  return {
    inputs: (request.input_images ?? []).map((dataUrl) => dataUrlToFile(dataUrl, 'image.png')),
    ...(request.mask ? { mask: dataUrlToFile(request.mask, 'mask.png') } : {}),
  }
}

function buildOpenAIEditFormData(
  model: string,
  request: HydratedSubmitRequest,
  files: OpenAIEditFiles,
): FormData {
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', request.prompt)
  if (request.size) form.append('size', request.size)
  if (request.quality) form.append('quality', request.quality)
  if (request.output_format) form.append('output_format', request.output_format)
  if (request.moderation) form.append('moderation', request.moderation)
  if (request.output_compression != null) {
    form.append('output_compression', String(request.output_compression))
  }
  for (const input of files.inputs) form.append('image[]', input)
  if (files.mask) form.append('mask', files.mask)
  // edits 不接受 n；数量由本地 fan-out 实现。其余 extra 标量字段原样透传。
  for (const [k, v] of Object.entries(request.extra ?? {})) {
    if (k === 'n' || v == null) continue
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return form
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
  if (!m) throw new Error('input_images 中的数据 URL 格式无效，必须是 data:<mime>;base64,<...>')
  const mime = m[1]!
  const bin = atob(m[2]!)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], filename, { type: mime })
}

function buildGeminiBody(request: HydratedSubmitRequest): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [{ text: request.prompt }]
  for (const dataUrl of request.input_images ?? []) {
    const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
  }

  const { generationConfig: extraGenerationConfig, ...extraTopLevel } = (request.extra ?? {}) as {
    generationConfig?: Record<string, unknown>
    [key: string]: unknown
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] }
  if (request.aspect_ratio || request.image_size) {
    generationConfig.imageConfig = {
      ...(request.aspect_ratio ? { aspectRatio: request.aspect_ratio } : {}),
      ...(request.image_size ? { imageSize: request.image_size } : {}),
    }
  }
  if (request.thinking_level) {
    generationConfig.thinkingConfig = { thinkingLevel: request.thinking_level }
  }

  return {
    contents: [{ role: 'user', parts }],
    // extra.generationConfig 放最后：调用方显式给的配置压过这里从扁平参数推导的默认值。
    generationConfig: { ...generationConfig, ...extraGenerationConfig },
    ...extraTopLevel,
  }
}

/** 非 2xx 时打 log 落的 payload 截断上限，避免上游回 base64 巨长串吞内存。 */
const UPSTREAM_ERROR_LOG_BYTES = 2000

async function parseUpstreamResponse(res: UpstreamResponse): Promise<UpstreamCallResult> {
  const text = await res.text()
  let payload: unknown = text
  try {
    payload = JSON.parse(text)
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    const message = extractErrorMessage(payload, res.status)
    // 上游 envelope 完整落 log（截断）：extractErrorMessage 可能把诊断信息提取
    // 成兜底字符串（如 "Upstream request failed"），原始 body 里的 error.code /
    // 上游真错因（"upstream did not return image output" 等）会丢，这里补回。
    log.warn(
      {
        event: 'upstream.non_2xx',
        upstreamStatus: res.status,
        message,
        payloadPreview:
          typeof payload === 'object' && payload !== null
            ? JSON.stringify(payload).slice(0, UPSTREAM_ERROR_LOG_BYTES)
            : String(payload).slice(0, UPSTREAM_ERROR_LOG_BYTES),
      },
      'upstream returned non-2xx',
    )
    const err = new Error(message) as Error & { upstreamStatus: number; upstreamPayload: unknown }
    err.upstreamStatus = res.status
    err.upstreamPayload = payload
    throw err
  }
  return { payload }
}

function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const errObj = obj.error as { message?: string } | string | undefined
    if (typeof errObj === 'object' && typeof errObj?.message === 'string') return errObj.message
    if (typeof errObj === 'string') return errObj
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.detail === 'string') return obj.detail
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.length > 500 ? `${payload.slice(0, 500)}…` : payload
  }
  return `Upstream HTTP ${status}`
}
