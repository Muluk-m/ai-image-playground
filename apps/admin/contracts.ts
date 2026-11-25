import type {
  AdminUserRow,
  AnalysisTaskDetail,
  DeviceDetailResult,
  DeviceRow,
  GenerationActor,
  GenerationTaskFilters,
  GenerationTaskItem,
  GenerationTasksFacetOption,
  GenerationTasksFacets,
  GenerationTasksResult,
  GenerationTasksSummary,
  GenerationUsersOverview,
  ListAuditsResult,
  ListDevicesResult,
  ListUsersResult,
  OperatorAuditRow,
  OverviewActivityResult,
  OverviewClientError,
  OverviewErrorItem,
  OverviewPulseBucket,
  OverviewPulseWindow,
  OverviewResult,
  OverviewServerError,
  OverviewSummary,
  Range,
  ServerLogAvailability,
  SortDirection,
  SortKey,
  TaskActorType,
  TaskDetail,
  TaskGptRouteFilter,
  TaskHttpBucket,
  TaskImageMeta,
  TaskListItem,
  TaskPageSize,
  TaskSortField,
  TaskSource,
  TaskVolumeBucket,
  TimeWindow,
  TodayModelFailure,
  TodayModelStat,
  TodayOverviewResult,
  UserDetailResult,
  UserKpis,
  UserSegment,
  UserStatus,
  UserTasksResult,
  VolumeBucketUnit,
} from '@image-playground/read-models/types'
import {
  RANGES,
  SORT_DIRECTIONS,
  SORTS,
  TASK_ACTOR_TYPES,
  TASK_GPT_ROUTES,
  TASK_HTTP_BUCKETS,
  TASK_PAGE_SIZES,
  TASK_SORT_FIELDS,
  TASK_SOURCES,
  todayWindow,
} from '@image-playground/read-models/types'
import type { HostSample, OpsBackups, TaskStatus } from '@image-playground/shared'
import { TASK_STATUSES } from '@image-playground/shared'

export type {
  AdminUserRow,
  AnalysisTaskDetail,
  DeviceDetailResult,
  DeviceRow,
  GenerationActor,
  GenerationTaskFilters,
  GenerationTaskItem,
  GenerationTasksFacetOption,
  GenerationTasksFacets,
  GenerationTasksResult,
  GenerationTasksSummary,
  GenerationUsersOverview,
  ListAuditsResult,
  ListDevicesResult,
  ListUsersResult,
  OperatorAuditRow,
  OverviewActivityResult,
  OverviewClientError,
  OverviewErrorItem,
  OverviewPulseBucket,
  OverviewPulseWindow,
  OverviewResult,
  OverviewServerError,
  OverviewSummary,
  Range,
  ServerLogAvailability,
  SortDirection,
  SortKey,
  TaskActorType,
  TaskDetail,
  TaskGptRouteFilter,
  TaskHttpBucket,
  TaskImageMeta,
  TaskListItem,
  TaskPageSize,
  TaskSortField,
  TaskSource,
  TaskStatus,
  TaskVolumeBucket,
  TimeWindow,
  TodayModelFailure,
  TodayModelStat,
  TodayOverviewResult,
  UserDetailResult,
  UserKpis,
  UserSegment,
  UserStatus,
  UserTasksResult,
  VolumeBucketUnit,
}
export {
  RANGES,
  SORT_DIRECTIONS,
  SORTS,
  TASK_ACTOR_TYPES,
  TASK_GPT_ROUTES,
  TASK_HTTP_BUCKETS,
  TASK_PAGE_SIZES,
  TASK_SORT_FIELDS,
  TASK_SOURCES,
  todayWindow,
}

export const DEFAULT_RANGE: Range = '7d'
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

export const HEALTH_RANGES = ['6h', '24h', '7d'] as const
export type HealthRange = (typeof HEALTH_RANGES)[number]
export const DEFAULT_HEALTH_RANGE: HealthRange = '6h'

export const HEALTH_RANGE_META: Record<
  HealthRange,
  {
    readonly label: string
    readonly bucketLabel: string
    readonly windowSeconds: number
    readonly bucketSeconds: number
    readonly bucketCount: number
    readonly startLabel: string
  }
> = {
  '6h': {
    label: '6 小时',
    bucketLabel: '5 分钟/格',
    windowSeconds: 6 * 3600,
    bucketSeconds: 5 * 60,
    bucketCount: 72,
    startLabel: '6 小时前',
  },
  '24h': {
    label: '24 小时',
    bucketLabel: '15 分钟/格',
    windowSeconds: 24 * 3600,
    bucketSeconds: 15 * 60,
    bucketCount: 96,
    startLabel: '24 小时前',
  },
  '7d': {
    label: '7 天',
    bucketLabel: '2 小时/格',
    windowSeconds: 7 * 24 * 3600,
    bucketSeconds: 2 * 3600,
    bucketCount: 84,
    startLabel: '7 天前',
  },
}

export function parseHealthRange(value: unknown): HealthRange {
  return typeof value === 'string' && (HEALTH_RANGES as readonly string[]).includes(value)
    ? (value as HealthRange)
    : DEFAULT_HEALTH_RANGE
}

export function parseHealthIncludePolicy(value: unknown): boolean {
  return value === '1' || value === 1 || value === 'true' || value === true
}

export type HealthStatus = 'healthy' | 'degraded' | 'outage' | 'idle'
export type HealthComponentKind = 'generation' | 'agent' | 'api'

export interface HealthBucket {
  readonly start_at: number
  readonly end_at: number
  readonly status: HealthStatus
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly success_rate: number | null
  readonly policy_blocked?: number
  readonly ttft_p50_ms?: number | null
  readonly ttft_p95_ms?: number | null
  readonly duration_p50_ms?: number | null
  readonly duration_p95_ms?: number | null
  readonly queue_wait_p50_ms?: number | null
}

export interface HealthComponent {
  readonly id: string
  readonly kind: HealthComponentKind
  readonly name: string
  readonly badge?: string | null
  readonly status: HealthStatus
  readonly availability: number | null
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly policy_blocked?: number
  readonly ttft_p50_ms?: number | null
  readonly ttft_p95_ms?: number | null
  readonly duration_p50_ms?: number | null
  readonly duration_p95_ms?: number | null
  readonly queue_wait_p50_ms?: number | null
  readonly buckets: readonly HealthBucket[]
}

export interface HealthGroup {
  readonly id: string
  readonly kind: HealthComponentKind
  readonly name: string
  readonly status: HealthStatus
  readonly availability: number | null
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly components: readonly HealthComponent[]
}

export interface HealthMonitorSummary {
  readonly status: HealthStatus
  readonly availability: number | null
  readonly generation_total: number
  readonly generation_availability: number | null
  readonly generation_p50_ms: number | null
  readonly agent_total: number
  readonly agent_availability: number | null
  readonly agent_ttft_p50_ms: number | null
  readonly api_total: number
  readonly api_availability: number | null
  readonly api_p95_ms: number | null
}

export interface HealthMonitorSnapshot {
  readonly generated_at: number
  readonly range: HealthRange
  readonly include_policy: boolean
  readonly bucket_ms: number
  readonly bucket_count: number
  readonly window_start_at: number
  readonly window_end_at: number
  readonly summary: HealthMonitorSummary
  readonly groups: readonly HealthGroup[]
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

export const TASK_SOURCE_LABELS: Record<TaskSource, string> = {
  chat: 'Chat',
  cli: 'CLI',
  manual: '手动',
}

export function gptRouteLabel(route: TaskListItem['gpt_route']): string | null {
  return route === 'direct' ? 'OpenAI 直连' : route === 'sub2api' ? 'sub2api' : null
}

export const USER_SEGMENTS: readonly UserSegment[] = [
  'active-7d',
  'members',
  'expiring',
  'out-of-credits',
  'disabled',
]

export function parseUserSegment(value: unknown): UserSegment | undefined {
  return USER_SEGMENTS.find((segment) => segment === value)
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

export interface OpsAgentFailureSample {
  at: number
  /** 已脱敏的失败说明。老数据可能只有错误码，没有这段。 */
  message?: string
  request_id?: string
}

export interface OpsExceptionGroup {
  source: 'api' | 'generation' | 'agent'
  /** API 模板路由、生成错误类型，或 Agent 失败码。 */
  key: string
  count: number
  last_at: number
  example_task_id?: string
  /** Agent 最近一条已脱敏的失败说明。接口路由和生成错误类型不带这段。 */
  detail?: string
  /** 这条 Agent 失败对应的请求，用来打开同一条服务端日志。 */
  example_request_id?: string
  /** 这一组里最近几次 Agent 失败，新的在前。 */
  samples?: OpsAgentFailureSample[]
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

/** 浏览器上报的错误。kind 的含义见 packages/shared/src/client-errors.ts。 */
export type ClientErrorKind = 'boot' | 'error' | 'rejection' | 'react'
export type ClientErrorSource = 'local' | 'automation' | 'marked_test' | 'unclassified'

/** 同一指纹在时间窗内聚成的一个问题；kind 以下几项取自最近一次。 */
export interface ClientErrorGroup {
  sources: Record<ClientErrorSource, number>
  recovered: number
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
  source: ClientErrorSource
  recovered_at: number | null
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

const DAY_MS = 86400_000

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

function parseTokenList(value: unknown, maxItems = 20): string[] | undefined {
  const rawParts =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : null
  if (!rawParts) return undefined
  const items = [
    ...new Set(
      rawParts.map((part) => part.trim()).filter((part) => part.length > 0 && part.length <= 128),
    ),
  ]
  return items.length ? items.slice(0, maxItems) : undefined
}

function parseEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  const tokens = parseTokenList(value, allowed.length)
  if (!tokens) return undefined
  const filtered = tokens.filter((token): token is T =>
    (allowed as readonly string[]).includes(token),
  )
  return filtered.length ? filtered : undefined
}

export function parseGenerationTaskFilters(input: Record<string, unknown>): GenerationTaskFilters {
  const out: GenerationTaskFilters = { ...parseTimeWindow(input) }
  for (const key of ['userId', 'deviceId', 'model'] as const) {
    if (typeof input[key] === 'string' && input[key].trim().length > 0 && input[key].length <= 128)
      out[key] = input[key].trim()
  }
  const models = parseTokenList(input.models)
  if (models) out.models = models
  const providers = parseTokenList(input.providers)
  if (providers) out.providers = providers
  const errorTypes = parseTokenList(input.errorTypes)
  if (errorTypes) out.errorTypes = errorTypes
  if (input.source === 'chat' || input.source === 'cli' || input.source === 'manual')
    out.source = input.source
  const sources = parseEnumList(input.sources, TASK_SOURCES)
  if (sources) out.sources = sources
  if (input.unassigned === '1') out.unassigned = '1'
  if ((TASK_ACTOR_TYPES as readonly string[]).includes(input.actorType as string))
    out.actorType = input.actorType as TaskActorType
  if (TASK_STATUSES.includes(input.status as TaskStatus)) out.status = input.status as TaskStatus
  const statuses = parseEnumList(input.statuses, TASK_STATUSES)
  if (statuses) out.statuses = statuses
  if ((TASK_GPT_ROUTES as readonly string[]).includes(input.gptRoute as string))
    out.gptRoute = input.gptRoute as TaskGptRouteFilter
  const httpBuckets = parseEnumList(input.httpBuckets, TASK_HTTP_BUCKETS)
  if (httpBuckets) out.httpBuckets = httpBuckets
  if (input.retried === '1') out.retried = '1'
  if (typeof input.q === 'string') {
    const q = input.q.trim()
    if (q.length > 0 && q.length <= 200) out.q = q
  }
  if (input.minDurationSec !== undefined && input.minDurationSec !== '') {
    const seconds = Number(input.minDurationSec)
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400) out.minDurationSec = seconds
  }
  if (input.maxDurationSec !== undefined && input.maxDurationSec !== '') {
    const seconds = Number(input.maxDurationSec)
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400) out.maxDurationSec = seconds
  }
  if (input.minQueueSec !== undefined && input.minQueueSec !== '') {
    const seconds = Number(input.minQueueSec)
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400) out.minQueueSec = seconds
  }
  if ((TASK_SORT_FIELDS as readonly string[]).includes(input.sort as string))
    out.sort = input.sort as TaskSortField
  if ((SORT_DIRECTIONS as readonly string[]).includes(input.dir as string))
    out.dir = input.dir as SortDirection
  if (input.page !== undefined && input.page !== '') {
    const page = Number(input.page)
    if (Number.isInteger(page) && page >= 1 && page <= 10_000) out.page = page
  }
  if (input.pageSize !== undefined && input.pageSize !== '') {
    const pageSize = Number(input.pageSize)
    if (pageSize === 50 || pageSize === 100) out.pageSize = pageSize
  }
  return out
}

export interface GenerationOverviewResult extends GenerationUsersOverview {
  activity: OverviewActivityResult
}

export type AgentPromptStatus = 'awaiting' | 'running' | 'completed' | 'failed'
export interface AgentPromptFilters extends TimeWindow {
  taskId?: string
  status?: AgentPromptStatus
  edited?: 'true' | 'false' | 'unknown'
  userId?: string
  deviceId?: string
  q?: string
}
export interface AgentPromptItem {
  id: string
  kind: 'draft' | 'task'
  createdAt: number
  conversationId: string
  turnId: string | null
  userId: string | null
  deviceId: string | null
  username: string | null
  prompt: string
  draftedPrompt: string | null
  edited: boolean | null
  status: AgentPromptStatus
  tool: string
  media: string
  model: string
  taskId: string | null
  /** Stable instruction identity; tasks from one tool call share it. */
  groupId?: string | null
  /** All queue tasks emitted by the same tool instruction, including taskId. */
  taskIds?: string[]
  userText: string | null
  chatModel: string | null
  inputTokens: number
  outputTokens: number
}
export interface AgentPromptsResult {
  items: AgentPromptItem[]
  window: TimeWindow
  summary: {
    total: number
    knownOriginal: number
    edited: number
    awaiting: number
    submitted: number
    failed: number
  } | null
  nextCursor: string | null
}

export function parseAgentPromptFilters(
  input: Record<string, unknown>,
  now = Date.now(),
): AgentPromptFilters | null {
  const window =
    input.from === undefined && input.to === undefined
      ? todayWindow(now)
      : parseTimeWindow(input, now)
  if (!window) return null
  const result: AgentPromptFilters = { ...window }
  if (input.status !== undefined) {
    if (!['awaiting', 'running', 'completed', 'failed'].includes(String(input.status))) return null
    result.status = input.status as AgentPromptStatus
  }
  if (input.edited !== undefined) {
    if (!['true', 'false', 'unknown'].includes(String(input.edited))) return null
    result.edited = input.edited as AgentPromptFilters['edited']
  }
  for (const key of ['userId', 'deviceId', 'taskId', 'q'] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim() || value.length > (key === 'q' ? 500 : 200))
      return null
    result[key] = value.trim()
  }
  if (result.userId && result.deviceId) return null
  return result
}
// ---- 能力与配额（运营覆盖） ----
export type OperatorSettingKind = 'capability' | 'quota'
export type OperatorSettingEditability = 'hot' | 'boot-time' | 'read-only'
export type OperatorSettingUnit =
  | 'boolean'
  | 'bytes'
  | 'seconds'
  | 'minutes'
  | 'count'
  | 'tokens'
  | 'pixels'
  | 'days'

export interface OperatorSettingRow {
  key: string
  kind: OperatorSettingKind
  name: string
  description: string
  domain: string
  editability: OperatorSettingEditability
  risk?: boolean
  baseline: boolean | number
  override: boolean | number | null
  effective: boolean | number
  reason: string | null
  revision: number
  updatedAt?: number | null
  unit?: OperatorSettingUnit
  min?: number
  max?: number
  dependencies?: string[]
  baselineChanged?: boolean
  invalid?: boolean
  invalidReason?: string | null
}

export interface OperatorSettingsResult {
  revision: number
  settings: OperatorSettingRow[]
}
