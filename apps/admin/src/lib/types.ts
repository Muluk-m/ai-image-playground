// 复用 admin server 的查询类型 —— 手抄而不是跨包 import（前端 bundle 不希望
// 把 server 依赖 drizzle/bun/elysia 拖进来）。schema 与 server 保持同步。
// 来源：apps/admin/server/lib/queries.ts

export type Range = '1d' | '7d' | '30d'
export type SortKey = 'last_seen' | 'today_count' | 'total_count'

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
}

// 配额上限（design.md 默认值，前端展示 "12 / 50" 用）；后续如改成 server 返
// 当日配额上限，把这里移到 response 字段。
export const DAILY_QUOTA_LIMIT = 50
