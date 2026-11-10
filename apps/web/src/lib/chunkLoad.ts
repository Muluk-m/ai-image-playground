import { type ComponentType, type LazyExoticComponent, lazy } from 'react'
import {
  BUILD_META_NAME,
  DYNAMIC_IMPORT_FAILURE,
  PRELOAD_RELOAD_STORAGE_KEY,
  RELOAD_QUERY_PARAM,
} from '../boot/constants'

export function isDynamicImportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return DYNAMIC_IMPORT_FAILURE.test(message)
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
 * 已发起刷新时挂起，不让错误先闪出来；预算用完则把错误交给错误边界或启动守卫。
 */
export function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (isDynamicImportFailure(error) && reloadOnceForChunkFailure()) {
        return new Promise<never>(() => {})
      }
      throw error
    }),
  )
}
