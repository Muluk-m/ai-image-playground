import type { HostSample, OpsBackups, TaskStatus } from '@image-playground/shared'

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

export type { HostSample, OpsBackupObject, OpsBackups } from '@image-playground/shared'

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

export interface OpsHostPoint {
  at: number
  /** 0 到 1。 */
  disk_used_ratio: number
  mem_available_ratio: number
  /** 旧采集容器没报 CPU 的时段为 null。 */
  cpu_busy_ratio: number | null
}

export interface OpsContainer {
  container_id: string
  /** 部署脚本的对照表里没有时为 null，看板显示 ID 前 12 位。 */
  name: string | null
  mem_bytes: number
  mem_limit_bytes: number | null
  cpu_cores: number | null
  oom_kills: number
  /** 近 7 天里这个容器用过的最多内存。 */
  peak_mem_bytes: number
  /** 近 24 小时新增的 OOM 次数。 */
  recent_oom_kills: number
}

export interface OpsContainers {
  /** 这批读数的时刻；一条都没有时为 null。 */
  sampled_at: number | null
  /** 按当前内存从大到小。 */
  containers: OpsContainer[]
}

export interface OpsApiPoint {
  at: number
  requests: number
  server_errors: number
  /** 这一格里最慢那一分钟的 P95。 */
  p95_ms: number | null
}

export interface OpsApiWindow {
  requests: number
  client_errors: number
  server_errors: number
  /** 窗口里最慢那一分钟的 P95。 */
  p95_ms: number | null
}

export interface OpsApi {
  /** 最近 15 分钟。 */
  recent: OpsApiWindow
  window_ms: number
  /** 近 24 小时，每 15 分钟一格，从旧到新。 */
  series: OpsApiPoint[]
  /** 近 1 小时返回 5xx 最多的路由。 */
  error_routes: Array<{ route: string; count: number }>
}

export interface OpsDeployment {
  at: number
  /** 部署的是哪一套：paid、internal，或 Pages 的发布名。 */
  target: string
  public_sha: string
  private_sha: string | null
  image: string
  by: string
  ok: boolean
}

export interface OpsDeployments {
  /** 这台后台所在的那套部署；用来标出「本套」。 */
  own: string | null
  /** 读不到部署记录（不是用部署脚本发的）时为 false。 */
  available: boolean
  /** 从新到旧。 */
  entries: OpsDeployment[]
}

export interface OpsHost {
  /** 最近一次读数；一条采样都没有（采集容器没启用）时是 null。 */
  latest: HostSample | null
  /** 近 7 天，按半小时取平均，从旧到新。看的是趋势：一直这么高，还是一天涨了十几个 G。 */
  series: OpsHostPoint[]
}

export interface OpsSnapshot {
  generated_at: number
  host: OpsBlock<OpsHost>
  services: OpsBlock<OpsServices>
  queue: OpsBlock<OpsQueue>
  database: OpsBlock<OpsDatabase>
  /** 真正落在对象存储里的备份文件；只有后端够得着，所以经它的内部接口取。 */
  backup: OpsBlock<OpsBackups>
  containers: OpsBlock<OpsContainers>
  api: OpsBlock<OpsApi>
  deployments: OpsBlock<OpsDeployments>
}
