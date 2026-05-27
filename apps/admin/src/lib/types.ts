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
  request_payload: unknown
  /** 含首次的总尝试次数；>1 表示发生过自动重试。 */
  attempt_count: number
}

export interface DeviceDetailResult {
  device: DeviceRow | null
  tasks: TaskListItem[]
  truncated: boolean
}

export interface TaskImageMeta {
  index: number
  mime: string
}

export interface TaskDetail extends TaskListItem {
  result_meta: { images: TaskImageMeta[]; raw_image_urls?: string[] }
  error_message: string | null
  device_id: string | null
  /** 仅 status='queued' 且 attempt_count>0 时有值——下次自动重试的目标时间戳。 */
  next_retry_at: number | null
}

// 配额上限（design.md 默认值，前端展示 "12 / 50" 用）；后续如改成 server 返
// 当日配额上限，把这里移到 response 字段。
export const DAILY_QUOTA_LIMIT = 80
