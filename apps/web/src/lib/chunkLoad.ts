import { type ComponentType, type LazyExoticComponent, lazy } from 'react'
import { BUILD_META_NAME, PRELOAD_RELOAD_STORAGE_KEY, RELOAD_QUERY_PARAM } from '../boot/constants'

/**
 * 只认分片下载失败。Safari 的裸 `Load failed` 也用于普通 fetch，不能触发刷新。
 * 模块本身 404 时 Vite 先派发 `vite:preloadError`，启动守卫已经用掉这次刷新；
 * 首帧后缺 CSS（`Unable to preload CSS`）守卫交给应用处理，就落到这里。
 */
const CHUNK_FAILURE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|unable to preload (?:css|js) for/i

export function isChunkFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === 'ChunkLoadError') return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return CHUNK_FAILURE.test(message)
}

/** 与启动守卫的 `retry()` 共用预算：同一份 HTML 构建只自动刷新一次，避免循环刷新。 */
export function reloadOnceForChunkFailure(): boolean {
  if (navigator.onLine === false) return false
  try {
    const htmlBuild =
      document.querySelector(`meta[name="${BUILD_META_NAME}"]`)?.getAttribute('content') ?? ''
    const spent = sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)
    const spentBuild = spent?.includes('|') ? spent.slice(spent.indexOf('|') + 1) : ''
    if (spent !== null && spentBuild === htmlBuild) return false
    sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, `${Date.now()}|${htmlBuild}`)
  } catch {
    return false
  }
  const next = new URL(window.location.href)
  next.searchParams.set(RELOAD_QUERY_PARAM, String(Date.now()))
  window.location.replace(next.href)
  return true
}

/**
 * 发版后旧标签请求的分片可能已不存在：刷新一次拿新 HTML。
 * 已发起刷新时挂起，不让错误先闪出来；预算用完则把错误交给错误边界。
 */
export function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (isChunkFailure(error) && reloadOnceForChunkFailure()) return new Promise<never>(() => {})
      throw error
    }),
  )
}
