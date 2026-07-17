import type { ApiMode, AppSettings, TaskParams } from '../types'

/**
 * BYOK adapter 消费的扁平 profile shape。
 *
 * `callImageApi` 把 `UserByokProfile`（含嵌套 preferences）拍平成这个结构再交给
 * OpenAI-compat / Gemini adapter，让 adapter 不必感知 `ClientProfile` 的 discriminated union。
 */
export interface BYOKAdapterProfile {
  baseUrl: string
  apiKey: string
  model: string
  apiMode: ApiMode
  timeout: number
  codexCli: boolean
  apiProxy: boolean
  responseFormatB64Json?: boolean
}

/**
 * 防改写的 prompt 头部 guard：Codex 系网关默认会改写用户 prompt，
 * 加这段前缀指示上游"原样使用 prompt 不要重写"。由 composer 的「防改写」开关
 * （`params.no_rewrite`，默认关闭）控制，在 `callImageApi` 分发层统一应用，
 * BYOK / edge 下游 adapter 无需感知。
 */
export const PROMPT_REWRITE_GUARD_PREFIX =
  'Use the following text as the complete prompt. Do not rewrite it:'

export function applyPromptRewriteGuard(prompt: string): string {
  return `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
}

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  maskDataUrl?: string
  onCustomTaskEnqueued?: (task: { taskId: string }) => void
  /** BFF queue 模式 submit 成功后立刻回调，把 request_id 持久化以便刷新后恢复 */
  onQueueSubmitted?: (requestId: string) => void
  /**
   * BFF queue 幂等键。callImageApi → queueClient.submit 透传给 BFF；BFF 用它
   * 去重，使「页面提交期间刷新→重提交」不会消耗双份上游配额。
   */
  clientRequestId?: string
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

export function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

export function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(`${label}过大：${formatMiB(bytes)}，上限为 ${formatMiB(maxBytes)}`)
  }
}

export function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes('图像输入有效负载总大小', bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

export function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
}

/**
 * Uint8Array / ArrayBuffer → data URL。chunked btoa 避免 `String.fromCharCode(...bytes)`
 * 在大图（几 MB+）触发 stack overflow（参数展开数量上限）。
 *
 * 不用 FileReader：vitest 默认 node 环境缺；浏览器侧表现一致。
 */
export function bytesToDataUrl(bytes: Uint8Array | ArrayBuffer, mime: string): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  return bytesToDataUrl(await blob.arrayBuffer(), blob.type || fallbackMime)
}

export const IMAGE_FETCH_CORS_HINT =
  ' 可点链接按钮复制结果链接，或尝试开启「返回 Base64 图片数据」避免此问题。'

async function probeNoCorsReachability(
  url: string,
  timeoutMs = 8000,
): Promise<'opaque' | 'reachable' | 'failed'> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.type === 'opaque' ? 'opaque' : 'reachable'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchImageUrlAsDataUrl(
  url: string,
  fallbackMime: string,
  signal?: AbortSignal,
): Promise<string> {
  if (isDataUrl(url)) return url

  let response: Response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      signal,
    })
  } catch (err) {
    if (err instanceof TypeError) {
      const probe = await probeNoCorsReachability(url)
      if (probe === 'opaque') {
        throw new Error(
          `图片已生成，但因服务商未允许跨域，图片链接下载失败。${IMAGE_FETCH_CORS_HINT}`,
        )
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(`图片链接下载失败（网络不可用）。${IMAGE_FETCH_CORS_HINT}`)
      }
      throw new Error(
        `图片链接下载失败（可能因跨域限制、链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`,
      )
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  const blob = await response.blob()
  return blobToDataUrl(blob, fallbackMime)
}

/**
 * 检测 builtin-edge proxy 返回的错误 envelope。
 *
 * 由于 keep-alive streaming 必须提前 send 200 OK status（status 一旦 flush 不能改），
 * proxy 把所有 upstream 错误（含网络失败 / 超时 / non-2xx）封装为：
 *   { error: { message, type, upstream_status? }, _proxyError: true, channelId }
 * 通过 body 通知前端。直连 user-byok 不经 proxy，不会触发此 path。
 *
 * 调用时机：所有走 `callImageApi` 的 fetch 在 `await response.json()` 之后、
 * 业务字段解析之前。
 */
export function throwIfProxyError(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const record = payload as Record<string, unknown>
  if (record._proxyError !== true) return
  const err = record.error as { message?: string } | undefined
  const msg = err?.message ?? '上游 API 调用失败（代理层）'
  throw new Error(msg)
}

export async function getApiErrorMessage(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (typeof errJson.detail === 'string') errorMsg = errJson.detail
    else if (Array.isArray(errJson.detail))
      errorMsg = errJson.detail
        .map((item: unknown) => (typeof item === 'string' ? item : JSON.stringify(item)))
        .join('\n')
    else if (typeof errJson.error === 'string') errorMsg = errJson.error
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await response.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

export function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (
    record.quality === 'auto' ||
    record.quality === 'low' ||
    record.quality === 'medium' ||
    record.quality === 'high'
  ) {
    actualParams.quality = record.quality
  }
  if (
    record.output_format === 'png' ||
    record.output_format === 'jpeg' ||
    record.output_format === 'webp'
  ) {
    actualParams.output_format = record.output_format
  }
  if (typeof record.output_compression === 'number')
    actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low')
    actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

export function mergeActualParams(
  ...sources: Array<Partial<TaskParams> | undefined>
): Partial<TaskParams> | undefined {
  const merged = Object.assign(
    {},
    ...sources.filter((source) => source && Object.keys(source).length),
  )
  return Object.keys(merged).length ? merged : undefined
}
