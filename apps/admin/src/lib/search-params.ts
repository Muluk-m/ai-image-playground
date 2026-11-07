// admin URL 状态约定 —— 详见 design.md "URL 状态约定"。
// 解析手写，不引 zod（admin 跟 BFF 一样保持轻量）。
import {
  INSPIRATION_KINDS,
  INSPIRATION_STATUSES,
  type InspirationKind,
  type InspirationStatus,
} from '@image-playground/shared'
import {
  type AgentPromptFilters,
  DEFAULT_OPS_RANGE,
  DEFAULT_RANGE,
  DEFAULT_SORT,
  type GenerationTaskFilters,
  OPS_RANGE_LABEL,
  OPS_RANGES,
  type OpsRange,
  parseAgentPromptFilters,
  parseGenerationTaskFilters,
  parseOpsRange,
  parseRange,
  parseSort,
  parseTimeWindow,
  RANGE_LABEL,
  RANGES,
  type Range,
  SORT_LABEL,
  SORTS,
  type SortKey,
} from '../../contracts'

export type { OpsRange, Range, SortKey }
export {
  DEFAULT_OPS_RANGE,
  DEFAULT_RANGE,
  DEFAULT_SORT,
  OPS_RANGE_LABEL,
  OPS_RANGES,
  parseOpsRange,
  parseRange,
  parseSort,
  RANGE_LABEL,
  RANGES,
  SORT_LABEL,
  SORTS,
}

export function parseTaskId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length > 0 && t.length <= 128 ? t : undefined
}

export function parseFullscreen(v: unknown): '1' | undefined {
  return v === '1' || v === 1 ? '1' : undefined
}

export function parseImgIdx(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isInteger(n) && n >= 0 && n < 1000) return n
  }
  return undefined
}

export type ImgKind = 'output' | 'input'
export function parseImgKind(v: unknown): ImgKind | undefined {
  return v === 'output' || v === 'input' ? v : undefined
}

/** Devices 列表 search —— 字段全部 optional：URL 缺省时 useSearch 返
 *  undefined，路由组件自己 coalesce 默认值。这样 navigate({to:'/devices'}) 不强
 *  制写 search 字段。
 */
export interface DevicesSearch {
  range?: Range
  sort?: SortKey
  q?: string
  preset?: DatePreset
  from?: number
  to?: number
  page?: number
  pageSize?: 50 | 100
}

function parsePage(value: unknown): number | undefined {
  const page = Number(value)
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : undefined
}

function parsePageSize(value: unknown): 50 | 100 | undefined {
  const size = Number(value)
  return size === 50 || size === 100 ? size : undefined
}

export function parseDevicesSearch(input: Record<string, unknown>): DevicesSearch {
  const out: DevicesSearch = {}
  if (input.range !== undefined) out.range = parseRange(input.range)
  if (input.sort !== undefined) out.sort = parseSort(input.sort)
  if (typeof input.q === 'string' && input.q.trim()) out.q = input.q.trim().slice(0, 128)
  if (
    input.preset === 'today' ||
    input.preset === '7d' ||
    input.preset === '30d' ||
    input.preset === 'custom'
  )
    out.preset = input.preset
  const page = parsePage(input.page)
  if (page) out.page = page
  const pageSize = parsePageSize(input.pageSize)
  if (pageSize) out.pageSize = pageSize
  if (input.from !== undefined || input.to !== undefined) {
    const window = parseTimeWindow(input)
    if (!window) throw new Error('设备时间范围无效：最多 31 天。')
    out.from = window.from
    out.to = window.to
  }
  return out
}

export type DatePreset = 'today' | '7d' | '30d' | 'custom'

export interface DashboardSearch {
  preset?: DatePreset
  from?: number
  to?: number
  /** 缺省对比上一周期；`0` 只看当前窗。 */
  compare?: '0'
}

export function parseDashboardSearch(input: Record<string, unknown>): DashboardSearch {
  const preset =
    input.preset === 'today' ||
    input.preset === '7d' ||
    input.preset === '30d' ||
    input.preset === 'custom'
      ? input.preset
      : undefined
  const out: DashboardSearch = {}
  if (preset) out.preset = preset
  if (input.compare === '0') out.compare = '0'
  if (preset === 'custom') {
    const window = parseTimeWindow(input)
    if (!window) throw new Error('自定义范围无效：需要起止时间，且不超过 31 天。')
    out.from = window.from
    out.to = window.to
  }
  return out
}

export interface OverviewSearch {
  range?: Range
}

export function parseOverviewSearch(input: Record<string, unknown>): OverviewSearch {
  return input.range === undefined ? {} : { range: parseRange(input.range) }
}

export interface OpsSearch {
  range?: OpsRange
}

export function parseOpsSearch(input: Record<string, unknown>): OpsSearch {
  return input.range === undefined ? {} : { range: parseOpsRange(input.range) }
}

export interface UsersSearch {
  q?: string
  status?: 'active' | 'disabled'
  registeredFrom?: number
  registeredTo?: number
  activeFrom?: number
  activeTo?: number
  sort?: 'activity' | 'created' | 'login'
  dir?: 'asc' | 'desc'
  page?: number
  pageSize?: 50 | 100
  preset?: DatePreset | 'all'
}

function parseEpoch(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

export function parseUsersSearch(input: Record<string, unknown>): UsersSearch {
  const out: UsersSearch = {}
  if (typeof input.q === 'string') {
    const q = input.q.trim().slice(0, 128)
    if (q) out.q = q
  }
  if (input.status === 'active' || input.status === 'disabled') out.status = input.status
  if (input.sort === 'activity' || input.sort === 'created' || input.sort === 'login')
    out.sort = input.sort
  if (input.dir === 'asc' || input.dir === 'desc') out.dir = input.dir
  if (
    input.preset === 'all' ||
    input.preset === 'today' ||
    input.preset === '7d' ||
    input.preset === '30d' ||
    input.preset === 'custom'
  )
    out.preset = input.preset
  for (const key of ['registeredFrom', 'registeredTo', 'activeFrom', 'activeTo'] as const) {
    const value = parseEpoch(input[key])
    if (input[key] !== undefined && input[key] !== '' && value === undefined)
      throw new Error('用户时间筛选无效')
    if (value !== undefined) out[key] = value
  }
  const page = parsePage(input.page)
  if (page) out.page = page
  const pageSize = parsePageSize(input.pageSize)
  if (pageSize) out.pageSize = pageSize
  return out
}

/** 抽屉 + lightbox 的 URL 状态，设备详情与用户详情共用 */
interface TaskViewSearch {
  task?: string
  fullscreen?: '1'
  imgIdx?: number
  imgKind?: ImgKind
}

function parseTaskViewSearch(input: Record<string, unknown>): TaskViewSearch {
  const out: TaskViewSearch = {}
  const task = parseTaskId(input.task)
  if (task !== undefined) out.task = task
  const fs = parseFullscreen(input.fullscreen)
  if (fs !== undefined) out.fullscreen = fs
  const idx = parseImgIdx(input.imgIdx)
  if (idx !== undefined) out.imgIdx = idx
  const kind = parseImgKind(input.imgKind)
  if (kind !== undefined) out.imgKind = kind
  return out
}

export interface DeviceDetailSearch extends TaskViewSearch {
  range?: Range
}

export function parseDeviceDetailSearch(input: Record<string, unknown>): DeviceDetailSearch {
  const out: DeviceDetailSearch = parseTaskViewSearch(input)
  if (input.range !== undefined) out.range = parseRange(input.range)
  return out
}

export interface UserDetailSearch extends TaskViewSearch {
  status?: string
}

export function parseUserDetailSearch(input: Record<string, unknown>): UserDetailSearch {
  const out: UserDetailSearch = parseTaskViewSearch(input)
  if (typeof input.status === 'string') {
    const status = input.status.trim().slice(0, 32)
    if (status) out.status = status
  }
  return out
}

/** 关抽屉 / lightbox：把这四个字段从 search 里摘掉，其余原样保留。 */
export function clearTaskView<T extends TaskViewSearch>(
  previous: T | undefined,
): Omit<T, keyof TaskViewSearch> {
  const {
    task: _task,
    fullscreen: _fullscreen,
    imgIdx: _index,
    imgKind: _kind,
    ...rest
  } = previous ?? ({} as T)
  return rest
}

/** 灵感库列表：筛选和管理页签进 URL，刷新和后退都还原；`item` 让 ⌘K 能直达某一条。 */
export interface InspirationsSearch {
  status?: InspirationStatus
  kind?: InspirationKind
  q?: string
  item?: string
  tab?: 'items' | 'categories' | 'skills'
}

export function parseInspirationsSearch(input: Record<string, unknown>): InspirationsSearch {
  const out: InspirationsSearch = {}
  if (INSPIRATION_STATUSES.some((status) => status === input.status)) {
    out.status = input.status as InspirationStatus
  }
  if (INSPIRATION_KINDS.some((kind) => kind === input.kind)) {
    out.kind = input.kind as InspirationKind
  }
  if (typeof input.q === 'string') {
    const q = input.q.trim().slice(0, 128)
    if (q) out.q = q
  }
  if (typeof input.item === 'string') {
    const item = input.item.trim().slice(0, 128)
    if (item) out.item = item
  }
  return out
}

/**
 * 关抽屉：只摘掉 `item`，筛选原样留在 URL 里。
 * 约束写成 `{ item?: string }` 而不是 InspirationsSearch：router 传进来的是全站
 * search 字段的并集（`status` 在那里是宽的 string），收窄的约束会对不上。
 */
export function clearInspirationItem<T extends { item?: string }>(
  previous: T | undefined,
): Omit<T, 'item'> {
  const { item: _item, ...rest } = previous ?? ({} as T)
  return rest
}

export interface GenerationTasksSearch extends GenerationTaskFilters, TaskViewSearch {
  preset?: DatePreset
}
export function parseGenerationTasksSearch(input: Record<string, unknown>): GenerationTasksSearch {
  if ((input.from !== undefined || input.to !== undefined) && !parseTimeWindow(input))
    throw new Error('任务时间范围无效：需要完整的起止时间，范围不超过 31 天，且不能在未来。')
  const preset =
    input.preset === 'today' ||
    input.preset === '7d' ||
    input.preset === '30d' ||
    input.preset === 'custom'
      ? input.preset
      : undefined
  return {
    ...parseGenerationTaskFilters(input),
    ...parseTaskViewSearch(input),
    ...(preset ? { preset } : {}),
  }
}

export interface AuditSearch {
  action?: string
  operatorId?: string
  targetId?: string
  settingKey?: string
  from?: number
  to?: number
  preset?: DatePreset | 'all'
}

export function parseAuditSearch(input: Record<string, unknown>): AuditSearch {
  const out: AuditSearch = {}
  if (typeof input.action === 'string' && input.action.trim())
    out.action = input.action.trim().slice(0, 64)
  if (typeof input.operatorId === 'string' && input.operatorId.trim())
    out.operatorId = input.operatorId.trim().slice(0, 320)
  if (typeof input.targetId === 'string' && input.targetId.trim())
    out.targetId = input.targetId.trim().slice(0, 256)
  if (typeof input.settingKey === 'string' && input.settingKey.trim())
    out.settingKey = input.settingKey.trim().slice(0, 128)
  if (
    input.preset === 'all' ||
    input.preset === 'today' ||
    input.preset === '7d' ||
    input.preset === '30d' ||
    input.preset === 'custom'
  )
    out.preset = input.preset
  if (input.from !== undefined || input.to !== undefined) {
    const window = parseTimeWindow(input)
    if (!window) throw new Error('审计时间范围无效：最多 31 天。')
    out.from = window.from
    out.to = window.to
  }
  return out
}

export interface AgentPromptsSearch extends Partial<AgentPromptFilters>, TaskViewSearch {}
export function parseAgentPromptsSearch(input: Record<string, unknown>): AgentPromptsSearch {
  const parsed = parseAgentPromptFilters(input)
  if (!parsed) throw new Error('提示词筛选无效：请选择有效的归属、状态和不超过 31 天的时间范围。')
  const { from, to, ...filters } = parsed
  return {
    ...filters,
    ...(input.from === undefined && input.to === undefined ? {} : { from, to }),
    ...parseTaskViewSearch(input),
  }
}
