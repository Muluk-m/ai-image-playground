import { type ComponentType, type LazyExoticComponent, lazy } from 'react'
import {
  BUILD_META_NAME,
  PRELOAD_RELOAD_STORAGE_KEY,
  PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY,
  RELOAD_QUERY_PARAM,
} from '../boot/constants'

/**
 * 动态 import 在发布后或网络抖动时会失败。这里先再请求模块，仍失败才允许整页刷新一次。
 * 普通渲染错误、接口失败不能走进这条路径。
 */
export const CHUNK_IMPORT_ATTEMPTS = 2
export const CHUNK_IMPORT_BACKOFF_MS = 400

/** 启动守卫内联脚本与这里共用同一条判断，避免只改一边。 */
export const DYNAMIC_IMPORT_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|loading chunk [\w-]+ failed|\bload failed\b/i

const CHUNK_LOAD_PATTERNS = [
  DYNAMIC_IMPORT_FAILURE,
  /failed to fetch(?: dynamically imported module)?/i,
  /\bload failed\b/i,
  /unable to preload (?:css|js) for/i,
]

declare global {
  interface Window {
    /** 测试里替换启动守卫的动态 import。生产页面不设置。 */
    __aipImportChunk?: (url: string) => Promise<unknown>
  }
}

export function isChunkLoadError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ChunkLoadError'
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return CHUNK_LOAD_PATTERNS.some((pattern) => pattern.test(message))
}

export function isDynamicImportFailure(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ChunkLoadError'
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return DYNAMIC_IMPORT_FAILURE.test(message)
}

function htmlBuildId(): string {
  return document.querySelector(`meta[name="${BUILD_META_NAME}"]`)?.getAttribute('content') ?? ''
}

/** 与启动守卫的 `retry()` 同一条 sessionStorage 预算：同一份 HTML 自动刷新一次。 */
export function reloadOnceForChunkFailure(): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  try {
    const htmlBuild = htmlBuildId()
    const spent = sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)
    const spentBuild =
      spent === null ? null : spent.includes('|') ? spent.slice(spent.indexOf('|') + 1) : ''
    if (spent !== null && spentBuild === htmlBuild) return false
    sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, `${Date.now()}|${htmlBuild}`)
  } catch {
    return false
  }
  navigateFresh()
  return true
}

/**
 * 用户点「重新加载」：清掉自动刷新预算，并换一个 HTML 地址。
 * 路径、原有查询参数和 hash 都留着，只追加一次性参数，避免拿到缓存的旧入口。
 */
export function hardReload(): void {
  try {
    sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
    sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  } catch {
    // 隐私模式写不了存储时仍然刷新；写失败不能挡住用户的显式操作。
  }
  navigateFresh()
}

function navigateFresh(): void {
  const next = new URL(window.location.href)
  next.searchParams.set(RELOAD_QUERY_PARAM, String(Date.now()))
  window.location.replace(next.href)
}

export interface ImportRetryOptions {
  attempts?: number
  backoffMs?: number
  sleep?: (ms: number) => Promise<void>
  /**
   * 最后一次仍是分片错误时是否自动刷新。传函数可在测试里替换导航。
   * `false`：把错误抛回去，由启动守卫或错误边界决定。
   */
  reload?: boolean | (() => boolean)
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let reloadFlight: Promise<boolean> | null = null

/** 同一轮失败只导航一次。后来的 import 等这一次，不再各自抛错把故障页闪出来。 */
function coordinateReload(reload: boolean | (() => boolean)): Promise<boolean> {
  if (reloadFlight) return reloadFlight
  if (reload === false) return Promise.resolve(false)
  const run = typeof reload === 'function' ? reload : reloadOnceForChunkFailure
  const flight = Promise.resolve()
    .then(run)
    .finally(() => {
      if (reloadFlight === flight) reloadFlight = null
    })
  reloadFlight = flight
  return flight
}

/** 同一个 import 最多试 `attempts` 次（含第一次）。成功就不刷新；仍失败才走一次性刷新。 */
export async function importWithRetry<T>(
  load: () => Promise<T>,
  options: ImportRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? CHUNK_IMPORT_ATTEMPTS
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError('importWithRetry attempts must be an integer >= 1')
  }
  const backoffMs = options.backoffMs ?? CHUNK_IMPORT_BACKOFF_MS
  const sleep = options.sleep ?? defaultSleep
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (attempt > 0) await sleep(backoffMs * attempt)
      return await load()
    } catch (error) {
      last = error
      if (!isChunkLoadError(error) || attempt === attempts - 1) break
    }
  }
  if (!isChunkLoadError(last)) throw last
  const navigated = await coordinateReload(options.reload ?? true)
  if (navigated) return new Promise<T>(() => {})
  throw last
}

export function lazyWithRetry<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  options?: ImportRetryOptions,
): LazyExoticComponent<T> {
  return lazy(() => importWithRetry(load, options))
}
