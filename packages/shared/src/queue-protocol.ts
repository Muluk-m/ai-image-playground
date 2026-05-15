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
 * 失败原因分类。集中定义避免分散字符串笔误。
 * - `upstream_error`: 上游 fetch 抛错或返非 2xx
 * - `upstream_no_image`: 上游 HTTP 200 但解析不出图（Gemini 安全策略 / OpenAI 异常 envelope）
 * - `interrupted`: BFF 重启时被打断（startup recovery 标记）
 * - `unknown`: 兜底（理论上不应出现）
 */
export type TaskErrorType = 'upstream_error' | 'upstream_no_image' | 'interrupted' | 'unknown'

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
  /**
   * OpenAI mask edit 的遮罩 data URL（base64）。BFF 转 multipart 字段 mask。
   * 仅 OpenAI 走 /v1/images/edits 时生效；Gemini 路径忽略此字段。
   */
  mask?: string
  /** 额外原样转发给上游的请求体字段（如 OpenAI 的 response_format 等） */
  extra?: Record<string, unknown>
  /**
   * 客户端生成的幂等键。前端 submitTask 时为每个任务分配 UUID 并持久化到
   * IndexedDB；提交期间页面刷新后重提时带相同 ID，BFF 用它去重 → 返回已有
   * request_id，避免重复消耗上游配额。
   */
  client_request_id?: string
}

export interface SubmitResponse {
  request_id: string
  status: 'queued'
  submitted_at: number
}

/**
 * status='completed' 时直接内联到 StatusResponse 的结果元信息子集。让前端在
 * poll 拿到完成状态的同一次响应里就拿到 images 列表，省一次 `GET /requests/{id}`。
 * 与 ResultResponse 同名字段含义一致。
 */
export interface StatusResultMeta {
  images: ResultImageMeta[]
  actual_params?: { size?: string; quality?: string }
  raw_image_urls?: string[]
}

export interface StatusResponse {
  request_id: string
  status: TaskStatus
  submitted_at: number
  started_at?: number
  completed_at?: number
  /** 失败时携带；其它状态 undefined */
  error?: { message: string; type: TaskErrorType }
  /** completed 时由 BFF 填入，避免前端二次 GET /result 拿元信息 */
  result?: StatusResultMeta
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
  error?: { message: string; type: TaskErrorType }
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

/**
 * 队列层各时间常量集中地。BFF / web / launchd 都引用同一份；之前散在各文件里
 * 靠注释维系跨层不变量（如「前端 POLL_MAX > BFF 上游 timeout > BFF SHUTDOWN >
 * launchd ExitTimeOut」）—— 注释稍不留神就跟代码漂移。集中后任意改一个值
 * 都能就近看见相邻常量的关系。
 *
 * 不变量：
 *   POLL_MAX_MS  >  UPSTREAM_HARD_TIMEOUT_MS  >  SHUTDOWN_HARD_TIMEOUT_MS
 *   SHUTDOWN_HARD_TIMEOUT_MS  <  launchd ExitTimeOut (plist: 60s)
 */
export const QUEUE_TIMEOUTS = {
  /** 前端单任务 poll 上限：30 min。需 > 上游硬超时，否则上游正常返回时前端已放弃。 */
  POLL_MAX_MS: 30 * 60 * 1000,
  /** poll 退避梯度，attempt index 取 min(idx, len-1)。 */
  POLL_BACKOFF_MS: [500, 1000, 2000, 3000, 5000] as readonly number[],
  /** 连续 5 次 5xx/网络错误才放弃 poll（容忍 BFF 重启、cf tunnel 抖动）。 */
  POLL_MAX_CONSECUTIVE_FAILURES: 5,
  /** BFF 单次上游 fetch 硬超时：15 min（AbortController）。gpt-image-2 系列在 sub2api
   *  慢链路下偶尔会跑 4-5min；留 15min 给极端长尾。需 < POLL_MAX_MS（30min）。 */
  UPSTREAM_HARD_TIMEOUT_MS: 15 * 60 * 1000,
  /** BFF SIGTERM 后等 inflight drain 的硬上限；留 5s 给 launchd ExitTimeOut。 */
  SHUTDOWN_HARD_TIMEOUT_MS: 55 * 1000,
  /** 后台清理过期任务的轮询间隔。 */
  PURGE_INTERVAL_MS: 6 * 60 * 60 * 1000,
  /** 已完成/失败/取消任务保留时长，超过即删。 */
  TASK_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
} as const

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
