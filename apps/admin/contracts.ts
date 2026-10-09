import type {
  AgentBatchPriceSnapshot,
  AgentTurnUsage,
  AgentVisualEvidence,
  AnalysisCoverage,
  AnalysisFinding,
  HostSample,
  OpsBackups,
  TaskStatus,
} from '@image-playground/shared'
import { TASK_STATUSES } from '@image-playground/shared'

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

export const OPS_RANGES = ['1h', '6h', '24h', '7d'] as const
export type OpsRange = (typeof OPS_RANGES)[number]
export const DEFAULT_OPS_RANGE: OpsRange = '7d'

export function parseOpsRange(value: unknown): OpsRange {
  return typeof value === 'string' && (OPS_RANGES as readonly string[]).includes(value)
    ? (value as OpsRange)
    : DEFAULT_OPS_RANGE
}

export const OPS_RANGE_LABEL: Record<OpsRange, string> = {
  '1h': '1 小时',
  '6h': '6 小时',
  '24h': '24 小时',
  '7d': '7 天',
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
  kind?: 'queue' | 'analysis'
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

export interface AnalysisTaskDetail {
  pricing: AgentBatchPriceSnapshot
  reservedCredits: number
  actualCredits: number | null
  findings: readonly AnalysisFinding[] | null
  coverage: AnalysisCoverage | null
  evidence: readonly AgentVisualEvidence[] | null
  usage: AgentTurnUsage | null
  upstreamRequestId: string | null
  localRejection: string | null
}

export interface TaskDetail extends TaskListItem {
  analysis?: AnalysisTaskDetail
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
  note: string | null
  status: UserStatus
  created_at: number
  updated_at: number
  last_login_at: number | null
  login_methods: string[]
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
  /** 从提交到开始执行的等待时长中位数。上面两个耗时量的是开始执行到完成，不含排队。 */
  queue_p50_ms: number | null
}

/** 一个时间窗里的业务量；当前窗与紧挨着它的上一个同长度窗口各一份，用来算环比。 */
export interface OverviewPulseWindow {
  tasks: number
  completed: number
  failed: number
  /** 成功任务请求的张数之和。 */
  images: number
  /** 提交过生成任务或跑过 Agent 轮次的账号与匿名设备数。 */
  active: number
  signups: number
  agent_turns: number
  agent_failed: number
  agent_aborted: number
}

export interface OverviewPulseBucket {
  bucket_at: number
  tasks: number
  images: number
  active: number
  signups: number
  agent_completed: number
  agent_failed: number
  agent_aborted: number
}

export interface OverviewResult {
  summary: OverviewSummary
  volume: TaskVolumeBucket[]
  volume_bucket: VolumeBucketUnit
  /** previous_count 是上一个同长度窗口里同一原因的次数。 */
  failures: Array<{ error_type: string; count: number; previous_count: number }>
  pulse: {
    current: OverviewPulseWindow
    previous: OverviewPulseWindow
    /** 与 volume 同一套分桶。 */
    series: OverviewPulseBucket[]
  }
  agent_cache: {
    calls: number
    input_tokens: number
    cache_read_tokens: number
    first_call: { calls: number; input_tokens: number; cache_read_tokens: number }
    continuation: { calls: number; input_tokens: number; cache_read_tokens: number }
    models: Array<{
      model: string
      calls: number
      input_tokens: number
      cache_read_tokens: number
    }>
  }
  models: Array<{
    model: string
    count: number
    upstream_invocations: number
    average_multiplier: number | null
    completed: number
    failed: number
    /** 提交到开始执行的中位等待。 */
    queue_p50_ms: number | null
    /** 成功任务从开始执行到完成的 95 分位。 */
    run_p95_ms: number | null
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
  reconciling?: number
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
  /** worker 是否配置了告警 webhook；旧版本或 BFF 没上报时为 null。 */
  alerts_configured: boolean | null
}

export interface OpsServices {
  /**
   * 每个服务所有还活着的实例，加上它最近的那一个；按服务、再按最近心跳从新到旧。
   * 从没出现过心跳的服务不在列表里。
   */
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

export interface OpsReliabilityWindow {
  range: '24h' | '7d'
  requests: number
  server_errors: number
  /** 只按已采集的用户 API 请求计算；没有请求时为 null。 */
  availability: number | null
  last_api_sample_at: number | null
  generation_completed: number
  generation_failed: number
  agent_completed: number
  agent_failed: number
}

export interface OpsExceptionGroup {
  source: 'api' | 'generation' | 'agent'
  /** API 模板路由、生成错误类型，或 Agent 轮次失败。没有原始报错文本。 */
  key: string
  count: number
  last_at: number
  example_task_id?: string
}

export interface OpsReliability {
  recent: { generation_system: number; agent_failed: number }
  windows: OpsReliabilityWindow[]
  /** 近 24 小时，按次数排序。 */
  exceptions: OpsExceptionGroup[]
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
  /** 选定时间窗内的降采样趋势，从旧到新。 */
  series: OpsHostPoint[]
  /** 服务端降采样桶宽；前端据此识别真正断采样的空档。 */
  bucket_ms: number
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
  reliability: OpsBlock<OpsReliability>
  deployments: OpsBlock<OpsDeployments>
}

// ---- 审计 ----
// `operator_audits` 是运营写操作的事实记录，后台只读。字段名保持数据库列名，
// 免得页面上看到的动作名和排查时 SQL 里写的不是一个词。

export interface OperatorAuditRow {
  id: string
  operator_id: string
  action: string
  target_type: string
  target_id: string
  details: Record<string, unknown>
  created_at: number
}

export interface ListAuditsResult {
  audits: OperatorAuditRow[]
  nextCursor: string | null
}

/** 浏览器上报的错误。kind 的含义见 packages/shared/src/client-errors.ts。 */
export type ClientErrorKind = 'boot' | 'error' | 'rejection' | 'react'

/** 同一指纹在时间窗内聚成的一个问题；kind 以下几项取自最近一次。 */
export interface ClientErrorGroup {
  fingerprint: string
  kind: ClientErrorKind
  name: string | null
  message: string
  count: number
  devices: number
  users: number
  first_seen: number
  last_seen: number
  last_url: string | null
  last_release: string | null
}

export interface ClientErrorTrendBucket {
  bucket_at: number
  boot: number
  runtime: number
}

export interface ClientErrorsResult {
  range: Range
  bucket_unit: VolumeBucketUnit
  summary: { events: number; devices: number; boot_events: number; groups: number }
  trend: ClientErrorTrendBucket[]
  /** 按次数从多到少，最多 100 组。 */
  groups: ClientErrorGroup[]
}

export interface ClientErrorEvent {
  id: string
  received_at: number
  kind: ClientErrorKind
  name: string | null
  message: string
  stack: string | null
  url: string | null
  release: string | null
  device_id: string | null
  user_id: string | null
  user_agent: string | null
  context: Record<string, unknown> | null
}

export interface ClientErrorEventsResult {
  fingerprint: string
  /** 时间窗内最近的 50 次。 */
  events: ClientErrorEvent[]
}

export interface TimeWindow {
  from: number
  to: number
}

const DAY_MS = 86400_000
const BEIJING_OFFSET = 8 * 3600_000

export function todayWindow(now = Date.now()): TimeWindow {
  return { from: Math.floor((now + BEIJING_OFFSET) / DAY_MS) * DAY_MS - BEIJING_OFFSET, to: now }
}

export function parseTimeWindow(
  input: Record<string, unknown>,
  now = Date.now(),
): TimeWindow | undefined {
  if (input.from === undefined || input.to === undefined) return undefined
  const from = Number(input.from)
  const to = Number(input.to)
  return Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    to > from &&
    to - from <= 31 * DAY_MS &&
    to <= now + 60_000
    ? { from, to }
    : undefined
}

export interface GenerationTaskFilters {
  userId?: string
  deviceId?: string
  unassigned?: '1'
  status?: TaskStatus
  from?: number
  to?: number
}

export function parseGenerationTaskFilters(input: Record<string, unknown>): GenerationTaskFilters {
  const out: GenerationTaskFilters = { ...parseTimeWindow(input) }
  for (const key of ['userId', 'deviceId'] as const) {
    if (typeof input[key] === 'string' && input[key].trim().length > 0 && input[key].length <= 128)
      out[key] = input[key].trim()
  }
  if (input.unassigned === '1') out.unassigned = '1'
  if (TASK_STATUSES.includes(input.status as TaskStatus)) out.status = input.status as TaskStatus
  return out
}

export interface GenerationActor {
  kind: 'user' | 'device' | 'unassigned'
  id: string | null
  username: string | null
  note: string | null
  tasks: number
  completed: number
  failed: number
  in_progress: number
  queued: number
  reconciling: number
  last_submitted_at: number
}

export interface TodayOverviewResult {
  window: TimeWindow
  actors: GenerationActor[]
  truncated: boolean
  summary: {
    users: number
    devices: number
    tasks: number
    completed: number
    failed: number
    in_progress: number
    queued: number
    reconciling: number
  }
}

export interface GenerationTaskItem extends TaskListItem {
  user_id: string | null
  device_id: string | null
  username: string | null
}

export interface GenerationTasksResult {
  window: TimeWindow
  tasks: GenerationTaskItem[]
  nextCursor: string | null
}

export interface TodayErrorItem {
  instance?: string | null
  source: 'server' | 'client'
  id: string
  at: number
  service: string
  message: string
  task_id: string | null
  request_id: string | null
  group: string | null
  stack: string | null
}

export interface TodayErrorsResult {
  window: TimeWindow
  total: number
  entries: TodayErrorItem[]
}
