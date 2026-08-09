export type Range = '1d' | '7d' | '30d'
export type SortKey = 'last_seen' | 'today_count' | 'total_count'

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
  prompt: string
  n: number | null
  attempt_count: number
}

export interface DeviceDetailResult {
  device: DeviceRow | null
  tasks: TaskListItem[]
  nextCursor: string | null
}

export interface TaskImageMeta {
  index: number
  mime: string
}

export interface TaskDetail extends TaskListItem {
  request_payload: unknown
  result_meta: { images: TaskImageMeta[]; raw_image_urls?: string[] }
  error_message: string | null
  device_id: string | null
  user_id: string | null
  next_retry_at: number | null
  upstream_invocation_count: number
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
  user: AdminUserRow | null
  tasks: TaskListItem[]
  nextCursor: string | null
  volume: TaskVolumeBucket[] | null
}

export interface OverviewSummary {
  total: number
  completed: number
  failed: number
  success_rate: number
  p50_duration_ms: number | null
  p95_duration_ms: number | null
  upstream_invocations: number
}

export interface OverviewResult {
  summary: OverviewSummary
  volume: TaskVolumeBucket[]
  failures: Array<{ error_type: string; count: number }>
  models: Array<{
    model: string
    count: number
    upstream_invocations: number
    average_multiplier: number | null
  }>
}
