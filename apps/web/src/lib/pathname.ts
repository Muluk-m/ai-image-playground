import { useEffect, useState } from 'react'

const pathnameListeners = new Set<() => void>()

/** pushState 不发 popstate。改完地址后调用，让 `usePathname` 跟上。 */
export function notifyPathname(): void {
  for (const listener of pathnameListeners) listener()
}

/** 当前地址。pushState 本身不发 popstate，调用方导航后要自己发。 */
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
    window.addEventListener('popstate', sync)
    return () => {
      pathnameListeners.delete(sync)
      window.removeEventListener('popstate', sync)
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
