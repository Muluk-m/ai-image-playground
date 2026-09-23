// admin URL 状态约定 —— 详见 design.md "URL 状态约定"。
// 解析手写，不引 zod（admin 跟 BFF 一样保持轻量）。
import {
  INSPIRATION_KINDS,
  INSPIRATION_STATUSES,
  type InspirationKind,
  type InspirationStatus,
} from '@image-playground/shared'
import {
  DEFAULT_RANGE,
  DEFAULT_SORT,
  parseRange,
  parseSort,
  RANGE_LABEL,
  RANGES,
  type Range,
  SORT_LABEL,
  SORTS,
  type SortKey,
} from '../../contracts'

export type { Range, SortKey }
export {
  DEFAULT_RANGE,
  DEFAULT_SORT,
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
}

export function parseDevicesSearch(input: Record<string, unknown>): DevicesSearch {
  const out: DevicesSearch = {}
  if (input.range !== undefined) out.range = parseRange(input.range)
  if (input.sort !== undefined) out.sort = parseSort(input.sort)
  return out
}

export interface OverviewSearch {
  range?: Range
}

export function parseOverviewSearch(input: Record<string, unknown>): OverviewSearch {
  return input.range === undefined ? {} : { range: parseRange(input.range) }
}

export interface UsersSearch {
  q?: string
}

export function parseUsersSearch(input: Record<string, unknown>): UsersSearch {
  if (typeof input.q !== 'string') return {}
  const q = input.q.trim().slice(0, 128)
  return q ? { q } : {}
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

/** 灵感库列表：筛选进 URL，刷新和后退都还原；`item` 让 ⌘K 能直达某一条。 */
export interface InspirationsSearch {
  status?: InspirationStatus
  kind?: InspirationKind
  q?: string
  item?: string
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
