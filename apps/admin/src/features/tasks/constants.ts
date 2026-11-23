import type { TaskDatePreset } from '@/lib/search-params'
import type {
  GenerationTaskFilters,
  TaskActorType,
  TaskGptRouteFilter,
  TaskHttpBucket,
  TaskSortField,
  TaskSource,
  TaskStatus,
  TimeWindow,
} from '../../../contracts'
import { todayWindow } from '../../../contracts'

export const TASK_PRESETS: ReadonlyArray<{ value: TaskDatePreset; label: string }> = [
  { value: '1h', label: '近 1h' },
  { value: 'today', label: '今天' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'custom', label: '自定义' },
]

export function taskPresetWindow(
  preset: Exclude<TaskDatePreset, 'custom'>,
  now = Date.now(),
): TimeWindow {
  if (preset === 'today') return todayWindow(now)
  if (preset === '1h') return { from: now - 3600_000, to: now }
  if (preset === '24h') return { from: now - 86_400_000, to: now }
  const days = preset === '7d' ? 7 : 30
  return { from: now - days * 86_400_000, to: now }
}

export const STATUS_ORDER: readonly TaskStatus[] = [
  'in_progress',
  'queued',
  'reconciling',
  'completed',
  'failed',
  'cancelled',
]

export const STATUS_META: Record<TaskStatus, { label: string; dotClass: string; pulse?: boolean }> =
  {
    in_progress: { label: '运行中', dotClass: 'bg-info', pulse: true },
    queued: { label: '排队中', dotClass: 'bg-warning' },
    reconciling: { label: '待核查', dotClass: 'bg-warning' },
    completed: { label: '成功', dotClass: 'bg-success' },
    failed: { label: '失败', dotClass: 'bg-danger' },
    cancelled: { label: '已取消', dotClass: 'bg-muted-foreground' },
  }

export const SOURCE_OPTIONS: ReadonlyArray<{ value: TaskSource; label: string }> = [
  { value: 'manual', label: '手动' },
  { value: 'chat', label: 'Chat' },
  { value: 'cli', label: 'CLI' },
]

export const ERROR_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'upstream_timeout', label: '上游超时' },
  { value: 'upstream_error', label: '上游错误' },
  { value: 'rate_limited', label: '上游限流' },
  { value: 'content_policy', label: '内容审核拒绝' },
  { value: 'model_unavailable', label: '模型不可用' },
  { value: 'upstream_result_unknown', label: '结果未确认' },
  { value: 'unknown', label: '未分类' },
]

export const ERROR_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ERROR_OPTIONS.map((item) => [item.value, item.label]),
)

export const GPT_ROUTE_OPTIONS: ReadonlyArray<{ value: TaskGptRouteFilter; label: string }> = [
  { value: 'direct', label: 'OpenAI 直连' },
  { value: 'sub2api', label: 'sub2api' },
  { value: 'none', label: '非 GPT / 默认' },
]

export const GPT_ROUTE_LABEL_MAP: Record<TaskGptRouteFilter, string> = {
  direct: 'OpenAI 直连',
  sub2api: 'sub2api',
  none: '非 GPT / 默认',
}

export const HTTP_BUCKET_OPTIONS: ReadonlyArray<{ value: TaskHttpBucket; label: string }> = [
  { value: '2xx', label: '2xx 成功' },
  { value: '4xx', label: '4xx 客户端/策略' },
  { value: '429', label: '429 上游限流' },
  { value: '5xx', label: '5xx 上游异常' },
  { value: 'none', label: '无上游响应' },
]

export const HTTP_BUCKET_LABEL_MAP: Record<TaskHttpBucket, string> = Object.fromEntries(
  HTTP_BUCKET_OPTIONS.map((item) => [item.value, item.label]),
) as Record<TaskHttpBucket, string>

export const ACTOR_TYPE_OPTIONS: ReadonlyArray<{ value: TaskActorType; label: string }> = [
  { value: 'user', label: '登录用户' },
  { value: 'device', label: '匿名设备' },
  { value: 'unassigned', label: '未归属' },
]

export const ACTOR_TYPE_LABEL_MAP: Record<TaskActorType, string> = {
  user: '登录用户',
  device: '匿名设备',
  unassigned: '未归属',
}

export const SORT_FIELD_OPTIONS: ReadonlyArray<{ value: TaskSortField; label: string }> = [
  { value: 'submitted_at', label: '提交时间' },
  { value: 'run_ms', label: '执行耗时' },
  { value: 'queue_ms', label: '排队等待' },
  { value: 'total_ms', label: '总耗时' },
  { value: 'attempt_count', label: '尝试次数' },
  { value: 'upstream_invocation_count', label: '上游调用数' },
  { value: 'upstream_status', label: '上游状态码' },
  { value: 'status', label: '状态优先级' },
]

export interface TaskPresetView {
  id: string
  name: string
  description: string
  search: Partial<GenerationTaskFilters> & { preset?: TaskDatePreset }
}

export const TASK_PRESET_VIEWS: readonly TaskPresetView[] = [
  {
    id: 'today-all',
    name: '今日全部任务',
    description: '按最新提交降序',
    search: { preset: 'today' },
  },
  {
    id: 'today-failed',
    name: '今日失败排障',
    description: '失败与待核查 · 最新优先',
    search: {
      preset: 'today',
      statuses: ['failed', 'reconciling'],
      sort: 'submitted_at',
      dir: 'desc',
    },
  },
  {
    id: 'slow-30s',
    name: '慢任务 (≥ 30s)',
    description: '近 7 天按执行耗时降序',
    search: { preset: '7d', minDurationSec: 30, sort: 'run_ms', dir: 'desc' },
  },
  {
    id: 'retried',
    name: '高频重试任务',
    description: '近 7 天有重试 · 按尝试次数降序',
    search: { preset: '7d', retried: '1', sort: 'attempt_count', dir: 'desc' },
  },
  {
    id: 'direct-errors',
    name: 'OpenAI 直连异常',
    description: '近 7 天直连失败任务',
    search: {
      preset: '7d',
      statuses: ['failed'],
      gptRoute: 'direct',
      sort: 'submitted_at',
      dir: 'desc',
    },
  },
  {
    id: 'active-queue',
    name: '进行中 & 队列监控',
    description: '运行中 / 排队中 / 待核查',
    search: {
      preset: 'today',
      statuses: ['in_progress', 'queued', 'reconciling'],
      sort: 'status',
      dir: 'asc',
    },
  },
]

export type TaskColumnId =
  | 'status'
  | 'submitted_at'
  | 'task_id'
  | 'actor'
  | 'prompt'
  | 'model'
  | 'source'
  | 'provider'
  | 'route'
  | 'run_ms'
  | 'queue_ms'
  | 'total_ms'
  | 'attempts'
  | 'upstream_status'
  | 'error_type'
  | 'device_id'

export interface TaskColumnDef {
  id: TaskColumnId
  label: string
  width: number
  align?: 'left' | 'right'
  sortField?: TaskSortField
}

export const TASK_COLUMNS: readonly TaskColumnDef[] = [
  { id: 'status', label: '状态', width: 104, sortField: 'status' },
  { id: 'submitted_at', label: '提交时间', width: 144, sortField: 'submitted_at' },
  { id: 'task_id', label: '任务 ID', width: 172 },
  { id: 'run_ms', label: '执行耗时', width: 96, align: 'right', sortField: 'run_ms' },
  { id: 'queue_ms', label: '排队等待', width: 96, align: 'right', sortField: 'queue_ms' },
  { id: 'actor', label: '用户 / 归属', width: 200 },
  { id: 'prompt', label: '需求 / 提示词', width: 300 },
  { id: 'model', label: '模型', width: 188 },
  { id: 'source', label: '来源', width: 76 },
  { id: 'provider', label: '供应商', width: 132 },
  { id: 'route', label: '通道 / 指纹', width: 196 },
  { id: 'total_ms', label: '总耗时', width: 92, align: 'right', sortField: 'total_ms' },
  { id: 'attempts', label: '尝试 / 上游', width: 110, align: 'right', sortField: 'attempt_count' },
  {
    id: 'upstream_status',
    label: '上游状态',
    width: 96,
    align: 'right',
    sortField: 'upstream_status',
  },
  { id: 'error_type', label: '错误类型', width: 184 },
  { id: 'device_id', label: '设备 ID', width: 140 },
]

export type TableDensity = 'compact' | 'standard'

export interface TasksTablePrefs {
  pinCount: 2 | 3 | 4
  hiddenCols: TaskColumnId[]
  density: TableDensity
  advancedOpen: boolean
}

const PREFS_KEY = 'admin.tasks.table-prefs.v1'
const DEFAULT_PREFS: TasksTablePrefs = {
  pinCount: 3,
  hiddenCols: [],
  density: 'compact',
  advancedOpen: true,
}

export function readTasksTablePrefs(): TasksTablePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<TasksTablePrefs>
    const validColIds = new Set<string>(TASK_COLUMNS.map((c) => c.id))
    return {
      pinCount: parsed.pinCount === 2 || parsed.pinCount === 4 ? parsed.pinCount : 3,
      hiddenCols: Array.isArray(parsed.hiddenCols)
        ? parsed.hiddenCols.filter(
            (id): id is TaskColumnId => typeof id === 'string' && validColIds.has(id),
          )
        : [],
      density: parsed.density === 'standard' ? 'standard' : 'compact',
      advancedOpen: typeof parsed.advancedOpen === 'boolean' ? parsed.advancedOpen : true,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function writeTasksTablePrefs(prefs: TasksTablePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 忽略隐私模式或配额受限
  }
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.floor(totalSec / 60)
  const rem = totalSec % 60
  return rem === 0 ? `${minutes}m` : `${minutes}m ${String(rem).padStart(2, '0')}s`
}
