import type {
  AgentBatchPriceSnapshot,
  AgentTurnUsage,
  AgentVisualEvidence,
  AnalysisCoverage,
  AnalysisFinding,
  TaskStatus,
} from '@image-playground/shared'

/**
 * Pure read-model contract types and browser-safe helpers.
 * Keep this file free of Drizzle, `@image-playground/db`, and Bun runtime imports so browser
 * bundles (e.g. `apps/admin/contracts.ts`) can import `@image-playground/read-models/types`
 * without pulling server dependencies into Vite.
 */

export const RANGES = ['1d', '7d', '30d'] as const
export type Range = (typeof RANGES)[number]

export const SORTS = ['last_seen', 'today_count', 'total_count'] as const
export type SortKey = (typeof SORTS)[number]

export interface TimeWindow {
  from: number
  to: number
}

const DAY_MS = 86400_000
const BEIJING_OFFSET = 8 * 3600_000

export function todayWindow(now = Date.now()): TimeWindow {
  return { from: Math.floor((now + BEIJING_OFFSET) / DAY_MS) * DAY_MS - BEIJING_OFFSET, to: now }
}

/** 桶粒度由服务端决定并随数据返回，前端不再从 range 反推。 */
export type VolumeBucketUnit = 'hour' | 'day'

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

export interface DeviceListOptions {
  q?: string
  page?: number
  pageSize?: 50 | 100
  from?: number
  to?: number
}

export interface ListDevicesResult {
  devices: DeviceRow[]
  truncated: boolean
  total: number
  page: number
  pageSize: number
}

export type TaskSource = 'chat' | 'cli' | 'manual'

export interface TaskListItem {
  source: TaskSource
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
  /** GPT Image 最终实际使用的通道；非 GPT 或旧任务为空。 */
  gpt_route: 'direct' | 'sub2api' | null
  /** OpenAI 直连 key 的安全指纹；只展示指纹，不展示密钥。 */
  gpt_key_fingerprint: string | null
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
  prompt_created_at?: number
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

export type UserSegment = 'active-7d' | 'members' | 'expiring' | 'out-of-credits' | 'disabled'

export interface UserListOptions {
  segment?: UserSegment
  segments?: boolean
  status?: 'active' | 'disabled'
  registeredFrom?: number
  registeredTo?: number
  activeFrom?: number
  activeTo?: number
  sort?: 'activity' | 'created' | 'login'
  dir?: 'asc' | 'desc'
  page?: number
  pageSize?: 50 | 100
  /** 是否开启商业计费能力（影响 members/expiring/out-of-credits 细分筛选）。 */
  billingCreditsEnabled?: boolean
}

export interface ListUsersResult {
  users: AdminUserRow[]
  segments?: Partial<Record<UserSegment | 'all', number>>
  truncated: boolean
  total: number
  page: number
  pageSize: number
}

export interface TaskVolumeBucket {
  bucket_at: number
  total: number
  completed: number
  failed: number
}

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

export interface OperatorAuditRow {
  id: string
  operator_id: string
  action: string
  target_type: string
  target_id: string
  details: Record<string, unknown>
  created_at: number
}

export interface ListOperatorAuditsOptions {
  cursor?: string
  limit?: number
  action?: string
  settingKey?: string
  targetId?: string
  operatorId?: string
  from?: number
  to?: number
}

export interface ListAuditsResult {
  audits: OperatorAuditRow[]
  nextCursor: string | null
}

export const TASK_PAGE_SIZES = [50, 100] as const
export type TaskPageSize = (typeof TASK_PAGE_SIZES)[number]

export const TASK_SOURCES = ['chat', 'cli', 'manual'] as const

export const TASK_SORT_FIELDS = [
  'submitted_at',
  'run_ms',
  'queue_ms',
  'total_ms',
  'attempt_count',
  'upstream_invocation_count',
  'upstream_status',
  'status',
] as const
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number]

export const SORT_DIRECTIONS = ['asc', 'desc'] as const
export type SortDirection = (typeof SORT_DIRECTIONS)[number]

export const TASK_GPT_ROUTES = ['direct', 'sub2api', 'none'] as const
export type TaskGptRouteFilter = (typeof TASK_GPT_ROUTES)[number]

export const TASK_HTTP_BUCKETS = ['2xx', '4xx', '429', '5xx', 'none'] as const
export type TaskHttpBucket = (typeof TASK_HTTP_BUCKETS)[number]

export const TASK_ACTOR_TYPES = ['user', 'device', 'unassigned'] as const
export type TaskActorType = (typeof TASK_ACTOR_TYPES)[number]

export interface GenerationTaskFilters {
  source?: TaskSource
  sources?: TaskSource[]
  userId?: string
  deviceId?: string
  unassigned?: '1'
  actorType?: TaskActorType
  status?: TaskStatus
  statuses?: TaskStatus[]
  /** 单模型深链。与 models 同时出现时合并。 */
  model?: string
  models?: string[]
  providers?: string[]
  gptRoute?: TaskGptRouteFilter
  errorTypes?: string[]
  httpBuckets?: TaskHttpBucket[]
  /** 执行耗时下限（秒）。在提交时间窗内过滤，不单独建表达式索引。 */
  minDurationSec?: number
  /** 执行耗时上限（秒）。 */
  maxDurationSec?: number
  /** 仅看尝试次数 > 1 的重试任务。 */
  retried?: '1'
  /** 排队等待时长下限（秒）。 */
  minQueueSec?: number
  /** 任务 ID、设备 ID、密钥指纹、模型、用户名或提示词在时间窗内的检索。 */
  q?: string
  sort?: TaskSortField
  dir?: SortDirection
  from?: number
  to?: number
  page?: number
  pageSize?: TaskPageSize
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

export interface TodayModelFailure {
  /** `queue_tasks.error_type`。没有记下类型时是 `unknown`。 */
  error_type: string
  count: number
}

export interface TodayModelStat {
  model: string
  tasks: number
  completed: number
  failed: number
  /** 含重试。一个任务可以对应多次上游调用。 */
  upstream_invocations: number
  /** 所选范围内该模型的失败原因，按次数从高到低。没有失败时是空数组。 */
  failures: TodayModelFailure[]
}

export interface TodayOverviewResult {
  window: TimeWindow
  actors: GenerationActor[]
  /** 所选范围内全部队列任务按模型汇总，不受用户列表 500 条截断影响。 */
  models: TodayModelStat[]
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

export type ServerLogAvailability = 'complete' | 'truncated' | 'unavailable' | 'off'

export interface OverviewErrorItem {
  id: string
  at: number
  message: string
  stack: string | null
}

export interface OverviewServerError extends OverviewErrorItem {
  service: string
  task_id: string | null
  request_id: string | null
  instance: string | null
}

export interface OverviewClientError extends OverviewErrorItem {
  fingerprint: string
  username: string | null
  user_id: string | null
  device_id: string | null
}

export interface OverviewActivityResult {
  window: TimeWindow
  tasks: GenerationTaskItem[]
  server: {
    /**
     * 服务端日志读得全不全（来自 OpenObserve）：`truncated` 时 total 是下限；
     * `unavailable`、`off` 时 total 为 0 但不代表没有错误。旧版本不带这个字段。
     */
    availability?: ServerLogAvailability
    total: number
    entries: OverviewServerError[]
  }
  client: { total: number; entries: OverviewClientError[] }
}

export type GenerationUsersOverview = Omit<TodayOverviewResult, 'models'>

export interface GenerationTasksSummary {
  total: number
  completed: number
  failed: number
  in_progress: number
  queued: number
  reconciling: number
  cancelled: number
  p50_run_ms: number | null
  p95_run_ms: number | null
}

export interface GenerationTasksFacetOption {
  value: string
  count: number
}

export interface GenerationTasksFacets {
  /** 忽略状态筛选、保留其余条件下的各状态条数，供状态快捷条显示实时计数。 */
  statusCounts: Record<TaskStatus, number>
  models: GenerationTasksFacetOption[]
  providers: GenerationTasksFacetOption[]
  errorTypes: GenerationTasksFacetOption[]
}

export interface GenerationTasksResult {
  window: TimeWindow
  tasks: GenerationTaskItem[]
  nextCursor: string | null
  total?: number
  page?: number
  pageSize?: number
  summary?: GenerationTasksSummary
  facets?: GenerationTasksFacets
}
