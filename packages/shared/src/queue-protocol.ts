/**
 * Image-playground 任务队列协议（BFF ↔ Web 共享）。
 *
 * 用 fal.ai queue API 的精简版：4 端点 + 5 状态。
 * 设计目标：浏览器经 CF Edge → BFF 全是 < 1s 短请求；BFF 在 mac mini 上
 * 用本机 localhost 调 sub2api，完全脱钩 HTTP 跳数限制（避开 CF Edge 100s 死线）。
 */

export type QueueProvider = 'openai-compat' | 'gemini'

export type TaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/**
 * POST /v1/queue/{provider}/{model}/submit
 *
 * payload 字段贴近 OpenAI Images / Gemini generateContent 的请求体子集；
 * BFF 不做参数转译，原样转发给上游（差异层在 web 客户端处理）。
 */
export interface SubmitRequest {
  prompt: string
  size?: string
  /**
   * OpenAI 协议层面是 'auto' | 'low' | 'medium' | 'high'；这里放宽为 string
   * 避免对 Elysia schema 编译器加 Union 验证压力 + 透传给上游本来就不做翻译。
   */
  quality?: string
  n?: number
  /** 参考图 data URL 数组（base64），上游处理时 BFF 透传 */
  input_images?: string[]
  /** 额外原样转发给上游的请求体字段（如 OpenAI 的 mask / response_format 等） */
  extra?: Record<string, unknown>
}

export interface SubmitResponse {
  request_id: string
  status: 'queued'
  submitted_at: number
}

export interface StatusResponse {
  request_id: string
  status: TaskStatus
  submitted_at: number
  started_at?: number
  completed_at?: number
  /** 失败时携带；其它状态 undefined */
  error?: { message: string; type: string }
}

/**
 * 单张图片的元信息（不含像素字节）。
 *
 * 像素字节通过 `GET /v1/queue/requests/{id}/image/{index}` 单独拿，避免在 JSON
 * 里塞 base64 走 cf tunnel 下行——base64 比原生 PNG/WebP 大 33%，且文本不便
 * gzip 高效压缩。
 */
export interface ResultImageMeta {
  index: number
  mime: string
  /** OpenAI revised_prompt 或 Gemini text part；可空 */
  revised_prompt?: string
  /** 像素尺寸（OpenAI 不一定返；Gemini 通过 BFF 自己解析） */
  width?: number
  height?: number
}

/**
 * GET /v1/queue/requests/{id}
 *
 * - completed: 返回 images 元信息列表 + actual_params + raw_image_urls；
 *   像素字节请通过 `GET /v1/queue/requests/{id}/image/{index}` 拉取
 * - failed: error 字段填
 * - 其它状态: 425 Too Early
 */
export interface ResultResponse {
  request_id: string
  status: TaskStatus
  /** completed 时 BFF 已从原始上游响应中抽出 */
  images?: ResultImageMeta[]
  /** OpenAI 路径上游回填的实际生效参数（size 等） */
  actual_params?: { size?: string; quality?: string }
  /** OpenAI 的 response_format=url 时上游直接给的 http URL 列表 */
  raw_image_urls?: string[]
  error?: { message: string; type: string }
}

/**
 * GET /v1/queue/requests/{id}/image/{index}
 *
 * - completed: 返回原始 image/png|image/webp|image/jpeg 二进制，
 *   Content-Type 来自 BFF 解析；强制 Cache-Control: public, max-age=31536000
 *   （request_id + index 是稳定 key）
 * - failed / cancelled / queued / in_progress: 404
 *
 * 这是一条纯字节响应，不走 JSON envelope。
 */

/** PUT /v1/queue/requests/{id}/cancel */
export interface CancelResponse {
  request_id: string
  status: TaskStatus
}

/** Channel 配置里新增 queue 类型时的客户端可见字段。 */
export interface QueueChannelView {
  id: string
  kind: 'openai-queue' | 'gemini-queue'
  label: string
  /** BFF base URL（cf tunnel 域名），客户端 fetch 用 */
  bffBaseUrl: string
  /** 上游 provider（决定 BFF 把请求转给 sub2api 哪个端点） */
  provider: QueueProvider
  /** 可选模型列表 */
  models: Array<{ id: string; label: string }>
  defaultModel: string
}
