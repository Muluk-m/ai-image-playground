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
  device_id: string | null
  user_id: string | null
  /** 仅 status='queued' 且 attempt_count>0 时有值——下次自动重试的目标时间戳。 */
  next_retry_at: number | null
}

export type UserStatus = 'active' | 'disabled'

export interface AdminUserRow {
  id: string
  username: string
  status: UserStatus
  created_at: number
  updated_at: number
  last_login_at: number | null
  last_task_at: number | null
  last_activity_at: number | null
  active_sessions: number
  task_count: number
}

export interface UserKpis {
  total_users: number
  active_users_7d: number
  submissions_24h: number
  failure_rate_24h: number
}

export interface ListUsersResult {
  users: AdminUserRow[]
  truncated: boolean
  kpis: UserKpis
}

export interface TaskVolumeBucket {
  bucket_at: number
  total: number
  completed: number
  failed: number
}

export interface UserDetailResult {
  /** Only the first task page includes profile aggregates. */
  user: AdminUserRow | null
  tasks: TaskListItem[]
  nextCursor: string | null
  volume: TaskVolumeBucket[] | null
}

export interface OverviewResult {
  summary: {
    total: number
    completed: number
    failed: number
    success_rate: number
    p50_duration_ms: number | null
    p95_duration_ms: number | null
  }
  volume: TaskVolumeBucket[]
  failures: Array<{ error_type: string; count: number }>
  models: Array<{ model: string; count: number }>
}
