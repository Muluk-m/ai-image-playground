// 复用 admin server 的查询类型 —— 手抄而不是跨包 import（前端 bundle 不希望
// 把 server 依赖 drizzle/bun/elysia 拖进来）。schema 与 server 保持同步。
// 来源：apps/admin/server/lib/queries.ts

export type Range = '1d' | '7d' | '30d'
export type SortKey = 'last_seen' | 'today_count' | 'total_count'

// admin server / BFF 已知的 task.status 值（status 列在 schema 里是 TEXT，
// 这里枚举出 UI 已经匹配的全部分支；落到 server 端实际值的源在
// `apps/bff/src/db/schema.ts` 与 `apps/admin/server/lib/queries.ts` 的 SUM CASE 分支）
export type TaskStatus =
  | 'queued'
  | 'in_progress'
  | 'running'
  | 'completed'
  | 'succeeded'
  | 'failed'
  | 'interrupted'

export interface DeviceRow {
  device_id: string
  first_seen: number
  last_seen: number
  total: number
  ok_count: number
  fail_count: number
  models: string[]
  today_count: number
}

export interface ListDevicesResult {
  devices: DeviceRow[]
  truncated: boolean
}

export interface TaskListItem {
  id: string
  provider: string
  model: string
  status: string
  submitted_at: number
  started_at: number | null
  completed_at: number | null
  error_type: string | null
  /** 上游 HTTP 状态码；仅 HTTP 层失败有值。5xx = 上游挂了，4xx = 请求本身有问题。 */
  upstream_status: number | null
  /** 服务端从 request_payload 预抽的 prompt 文本。列表不再回传整坨 request_payload，
   *  避免 input_images base64 把响应撑爆（admin 卡死/拉取慢的根因）。 */
  prompt: string
  /** 请求张数 n（openai 风格 payload）；无则 null */
  n: number | null
  /** 含首次的总尝试次数；>1 表示发生过自动重试。 */
  attempt_count: number
}

export interface DeviceDetailResult {
  /** 仅首页（cursor 为空）返回设备聚合卡片；翻页时为 null。 */
  device: DeviceRow | null
  tasks: TaskListItem[]
  /** 下一页游标；null 表示已到末页。 */
  nextCursor: string | null
}

export interface TaskImageMeta {
  index: number
  mime: string
}

export interface TaskDetail extends TaskListItem {
  /** 完整请求体：详情页 / 灯箱用它统计输入图数量、展示完整 prompt。列表项没有这个字段。 */
  request_payload: unknown
  result_meta: { images: TaskImageMeta[]; raw_image_urls?: string[] }
  error_message: string | null
  /** 上游错误响应体原文（BFF 侧已截断）。error_message 提取不到的 error.code 在这里。 */
  upstream_body: string | null
  device_id: string | null
  /** 仅 status='queued' 且 attempt_count>0 时有值——下次自动重试的目标时间戳。 */
  next_retry_at: number | null
}

// 配额上限（design.md 默认值，前端展示 "12 / 50" 用）；后续如改成 server 返
// 当日配额上限，把这里移到 response 字段。
export const DAILY_QUOTA_LIMIT = 80
