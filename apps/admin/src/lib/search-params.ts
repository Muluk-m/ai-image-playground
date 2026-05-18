// admin URL 状态约定 —— 详见 design.md "URL 状态约定"。
// 解析手写，不引 zod（admin 跟 BFF 一样保持轻量）。

export const RANGES = ['1d', '7d', '30d'] as const
export type Range = (typeof RANGES)[number]
export const DEFAULT_RANGE: Range = '7d'

export const SORTS = ['last_seen', 'today_count', 'total_count'] as const
export type SortKey = (typeof SORTS)[number]
export const DEFAULT_SORT: SortKey = 'last_seen'

export function parseRange(v: unknown): Range {
  return typeof v === 'string' && (RANGES as readonly string[]).includes(v)
    ? (v as Range)
    : DEFAULT_RANGE
}

export function parseSort(v: unknown): SortKey {
  return typeof v === 'string' && (SORTS as readonly string[]).includes(v)
    ? (v as SortKey)
    : DEFAULT_SORT
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

/** Device 详情 search（task / fullscreen / imgIdx / imgKind 控抽屉 + lightbox） */
export interface DeviceDetailSearch {
  range?: Range
  task?: string
  fullscreen?: '1'
  imgIdx?: number
  imgKind?: ImgKind
}

export function parseDeviceDetailSearch(input: Record<string, unknown>): DeviceDetailSearch {
  const out: DeviceDetailSearch = {}
  if (input.range !== undefined) out.range = parseRange(input.range)
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
