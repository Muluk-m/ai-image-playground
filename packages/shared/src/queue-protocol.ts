/**
 * Image-playground 任务队列协议（BFF ↔ Web 共享）。
 *
 * 用 fal.ai queue API 的精简版：4 端点 + 5 状态。
 * 设计目标：浏览器经 CF Edge → BFF 全是 < 1s 短请求；BFF 在 mac mini 上
 * BFF 用 localhost / 内网调上游 API，完全脱钩浏览器和 Edge 的 HTTP 长超时限制。
 */

export type QueueProvider = 'openai-compat' | 'gemini'

export type TaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** Server-side persisted image reference. Queue clients continue to submit data URL strings. */
export interface StoredImageRef {
  object: string
  mime: string
}

/**
 * 失败原因分类。集中定义避免分散字符串笔误。
 * - `upstream_timeout`: BFF 自己的 AbortController（UPSTREAM_HARD_TIMEOUT_MS）切的
 * - `upstream_result_unknown`: 请求发出后连接中断或超时，无法确认上游是否已完成
 * - `upstream_error`: 上游 HTTP 4xx/5xx 或 socket 异常关闭等其它 fetch 抛错
 * - `upstream_no_image`: 上游 HTTP 200 但解析不出图（Gemini 安全策略 / OpenAI 异常 envelope）
 * - `interrupted`: BFF 重启时被打断（startup recovery 标记）
 * - `object_storage_error`: object storage read/write failed after bounded local retries
 * - `unknown`: 兜底（理论上不应出现）
 */
export type TaskErrorType =
  | 'upstream_timeout'
  | 'upstream_result_unknown'
  | 'upstream_error'
  | 'upstream_no_image'
  | 'interrupted'
  | 'object_storage_error'
  | 'unknown'

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
  /** OpenAI Images 使用的输出格式。 */
  output_format?: string
  /** OpenAI Images 使用的输出压缩率（0-100）。 */
  output_compression?: number
  /** OpenAI Images 使用的内容审核级别。 */
  moderation?: string
  /** Gemini imageConfig 使用的宽高比。 */
  aspect_ratio?: string
  /** Gemini imageConfig 使用的图片尺寸档位。 */
  image_size?: string
  /** Gemini thinkingConfig 使用的思考级别。 */
  thinking_level?: string
  n?: number
  /** Reference image data URLs submitted by queue clients. */
  input_images?: string[]
  /**
   * OpenAI mask edit data URL. Only the server's persisted representation uses an object ref.
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
  /**
   * 浏览器持久化的设备 ID（localStorage UUID）。BFF 用于按设备每日配额计数。
   * 前端 submitTask 时统一带；缺失或格式异常时 BFF 返 400（Elysia schema 层
   * 运行时强制必填）。TS 层先标可选避免一次性 break 所有现存 callsite，下游
   * task 把 BFF/web 全部传上 device_id 后可考虑切到必填。
   */
  device_id?: string
}

/** BFF-only database representation after input pixel bytes move to object storage. */
export type PersistedSubmitRequest = Omit<SubmitRequest, 'input_images' | 'mask'> & {
  input_images?: StoredImageRef[]
  mask?: StoredImageRef
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
  actual_params?: { size?: string; quality?: string; output_format?: string }
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
  actual_params?: { size?: string; quality?: string; output_format?: string }
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
 * 队列层各时间常量集中地。BFF / web 都引用同一份；之前散在各文件里靠注释
 * 维系跨层不变量（如「前端 POLL_MAX > BFF 上游 timeout > BFF SHUTDOWN >
 * 进程管理器 kill timeout」）—— 注释稍不留神就跟代码漂移。集中后任意改一个值
 * 都能就近看见相邻常量的关系。
 *
 * 不变量：
 *   POLL_MAX_MS  >  UPSTREAM_HARD_TIMEOUT_MS  >  SHUTDOWN_HARD_TIMEOUT_MS
 *   SHUTDOWN_HARD_TIMEOUT_MS  <  进程管理器给 SIGTERM 的 graceful 期限
 *   （Docker `--stop-timeout` / systemd `TimeoutStopSec` / pm2 `kill_timeout`
 *    任一，至少要给 60s 才能让 BFF 顺利 drain 55s 后自己退出）
 */
export const QUEUE_TIMEOUTS = {
  /** 前端单任务 poll 上限：30 min。需 > 上游硬超时，否则上游正常返回时前端已放弃。 */
  POLL_MAX_MS: 30 * 60 * 1000,
  /** poll 退避梯度，attempt index 取 min(idx, len-1)。 */
  POLL_BACKOFF_MS: [500, 1000, 2000, 3000, 5000] as readonly number[],
  /** 连续 5 次 5xx/网络错误才放弃 poll（容忍 BFF 重启、cf tunnel 抖动）。 */
  POLL_MAX_CONSECUTIVE_FAILURES: 5,
  /** BFF 单次上游 fetch 硬超时：15 min（AbortController）。gpt-image-2 系列在慢链路
   *  下偶尔会跑 4-5min；留 15min 给极端长尾。需 < POLL_MAX_MS（30min）。 */
  UPSTREAM_HARD_TIMEOUT_MS: 15 * 60 * 1000,
  /** BFF SIGTERM 后等 inflight drain 的硬上限；进程管理器至少要给 60s graceful 期限。 */
  SHUTDOWN_HARD_TIMEOUT_MS: 55 * 1000,
  /** 后台清理过期任务的轮询间隔。 */
  PURGE_INTERVAL_MS: 6 * 60 * 60 * 1000,
  /** 已完成/失败/取消任务保留时长，超过即删。 */
  TASK_RETENTION_MS: 30 * 24 * 60 * 60 * 1000,
} as const

/**
 * 单设备单日最大生图张数。计数粒度是输出图数 n（n=4 的 submit 扣 4 张）。
 * 北京时间 8 点 / UTC 0 点重置。BYOK profile 不走 BFF，天然豁免。
 */
export const DAILY_QUOTA_LIMIT = 80

/** Channel 配置里新增 queue 类型时的客户端可见字段。 */
export interface QueueChannelView {
  id: string
  kind: 'openai-queue' | 'gemini-queue'
  label: string
  /** BFF base URL（cf tunnel 域名），客户端 fetch 用 */
  bffBaseUrl: string
  /** 上游 provider（决定 BFF 把请求转给上游哪个端点） */
  provider: QueueProvider
  /** 可选模型列表 */
  models: Array<{ id: string; label: string }>
  defaultModel: string
}
