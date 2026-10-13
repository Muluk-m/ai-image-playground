import { useEffect, useState } from 'react'

/** 当前地址。pushState 本身不发 popstate，调用方导航后要自己发。 */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  )
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
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
