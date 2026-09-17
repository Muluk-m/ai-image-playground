import type { OpsBackups, TaskStatus } from '@image-playground/shared'

export const RANGES = ['1d', '7d', '30d'] as const
export type Range = (typeof RANGES)[number]
export const DEFAULT_RANGE: Range = '7d'

export const SORTS = ['last_seen', 'today_count', 'total_count'] as const
export type SortKey = (typeof SORTS)[number]
export const DEFAULT_SORT: SortKey = 'last_seen'

export function parseRange(value: unknown): Range {
  return typeof value === 'string' && (RANGES as readonly string[]).includes(value)
    ? (value as Range)
    : DEFAULT_RANGE
}

export const RANGE_LABEL: Record<Range, string> = {
  '1d': '1 天',
  '7d': '7 天',
  '30d': '30 天',
}

export const SORT_LABEL: Record<SortKey, string> = {
  last_seen: '最近活跃',
  today_count: '今日任务',
  total_count: '范围总数',
}

export function parseSort(value: unknown): SortKey {
  return typeof value === 'string' && (SORTS as readonly string[]).includes(value)
    ? (value as SortKey)
    : DEFAULT_SORT
}

export const LOGIN_ERROR_CODES = ['not_allowed', 'oauth_failed'] as const
export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number]

export interface AdminLoginMethods {
  readonly google_login: boolean
  readonly password_login: boolean
}

export interface AdminSession {
  readonly accounts_login: boolean
  readonly accounts_sync: boolean
  readonly ok: true
}

export type { TaskStatus }

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
  status: TaskStatus
  submitted_at: number
  started_at: number | null
  completed_at: number | null
  error_type: string | null
  upstream_status: number | null
  prompt: string
  upstream_invocation_count: number
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
  upstream_body: string | null
  device_id: string | null
  user_id: string | null
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

/** 桶粒度由服务端决定并随数据返回，前端不再从 range 反推。 */
export type VolumeBucketUnit = 'hour' | 'day'

export interface UserDetailResult {
  user: AdminUserRow | null
  volume: TaskVolumeBucket[]
  volume_bucket: VolumeBucketUnit
  volume_range: Range
  /** 墓碑不计入两个计数；asset_bytes 是该用户已上传图片本体的总字节。 */
  template_count: number
  asset_count: number
  asset_bytes: number
}

export interface UserTasksResult {
  tasks: TaskListItem[]
  nextCursor: string | null
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
  volume_bucket: VolumeBucketUnit
  failures: Array<{ error_type: string; count: number }>
  models: Array<{
    model: string
    count: number
    upstream_invocations: number
    average_multiplier: number | null
  }>
}

// ---- 运维看板 ----
// 回答「这套部署现在有没有出事」。每一块独立取、独立失败：某一块拿不到时只有它带错误，
// 其余照常返回，页面也只在那一块显示取不到。

export type OpsBlock<T> = { ok: true; data: T } | { ok: false; error: string }

export interface OpsStuckTask {
  id: string
  model: string
  started_at: number
}

export interface OpsQueue {
  queued: number
  in_progress: number
  /** 最老的排队任务已经等了多久；队列为空时是 null。 */
  oldest_queued_wait_ms: number | null
  /** 运行超过这个时长即视为卡住，与 worker 回收无主任务用的是同一个阈值。 */
  stale_after_ms: number
  stuck: OpsStuckTask[]
}

export interface OpsDatabase {
  size_bytes: number
  /** 占用最大的几张表，从大到小。 */
  tables: Array<{ name: string; bytes: number }>
}

export type { OpsBackupObject, OpsBackups } from '@image-playground/shared'

export type OpsServiceName = 'bff' | 'worker'

export interface OpsService {
  service: OpsServiceName
  instance: string
  /** 镜像构建时打进去的来源提交；直接构建的镜像是 unknown。 */
  version: string
  last_seen_at: number
  /** 只有 worker 会报：活着不等于在干活。 */
  last_successful_poll_at: number | null
}

export interface OpsServices {
  /** 每个服务只报最新的那个实例；从没出现过心跳的服务不在列表里。 */
  services: OpsService[]
}

export interface OpsSnapshot {
  generated_at: number
  services: OpsBlock<OpsServices>
  queue: OpsBlock<OpsQueue>
  database: OpsBlock<OpsDatabase>
  /** 真正落在对象存储里的备份文件；只有后端够得着，所以经它的内部接口取。 */
  backup: OpsBlock<OpsBackups>
}
