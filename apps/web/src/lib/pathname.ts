import { useEffect, useState } from 'react'

const pathnameListeners = new Set<() => void>()
let pathnameRevision = 0

/** 地址即使离开后又回到原路径，也属于一次新导航。 */
export function getPathnameRevision(): number {
  return pathnameRevision
}

function notify(): void {
  pathnameRevision += 1
  for (const listener of pathnameListeners) listener()
}

/**
 * pushState / replaceState 不发 popstate，调用方各自通知又总会漏。
 * 在 History API 出口统一包一层：任何地方改了地址，`usePathname` 都跟上。
 */
function installHistoryNotifier(): void {
  if (typeof window === 'undefined') return
  const history = window.history
  const marked = history as History & { __pathnameNotifier?: true }
  if (marked.__pathnameNotifier) return
  marked.__pathnameNotifier = true
  window.addEventListener('popstate', notify)
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method]
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const before = window.location.pathname
      const result = original.apply(this, args)
      if (window.location.pathname !== before) notify()
      return result
    }
  }
}

installHistoryNotifier()

/** 当前地址。History API 写入与 popstate 都会同步。 */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  )
  useEffect(() => {
    const sync = () =>
      setPathname((current) => {
        const next = window.location.pathname
        return current === next ? current : next
      })
    pathnameListeners.add(sync)
    // 渲染到订阅之间的地址变化。
    sync()
    return () => {
      pathnameListeners.delete(sync)
    }
  }, [])
  return pathname
}

/** 站内换页，并通知还在听 popstate 的路由。 */
export function navigate(path: string): void {
  if (window.location.pathname === path) {
    window.dispatchEvent(new PopStateEvent('popstate'))
    return
  }
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
