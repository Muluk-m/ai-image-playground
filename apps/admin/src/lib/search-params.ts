// admin URL 状态约定 —— 详见 design.md "URL 状态约定"。
// 解析手写，不引 zod（admin 跟 BFF 一样保持轻量）。
import {
  DEFAULT_RANGE,
  DEFAULT_SORT,
  parseRange,
  parseSort,
  RANGES,
  type Range,
  SORTS,
  type SortKey,
} from '../../contracts'

export type { Range, SortKey }
export { DEFAULT_RANGE, DEFAULT_SORT, parseRange, parseSort, RANGES, SORTS }

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

/** 用户详情按全量历史展示，不接受时间窗。 */
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
