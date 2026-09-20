import type { CompatibilityConfig } from './bridge'

const DONE = 'muvloom-domain-auth-v1'
const CALLBACK = '__domain_auth'

export function legacyFallback(config: CompatibilityConfig, current = location.href): string {
  const url = new URL(current)
  const fallback = new URL(config.sourceOrigin)
  fallback.pathname = url.pathname
  fallback.search = url.search
  fallback.hash = url.hash
  fallback.searchParams.delete(CALLBACK)
  fallback.searchParams.set('__legacy', '1')
  return fallback.href
}

/**
 * Storage is committed before navigating; no session credential is exposed to JavaScript.
 *
 * 只有「登录还能接过来」这一件事失败时才值得改变航向，而它失败的方式几乎都不是「交接坏了」：
 * `accounts:login` 关着时 `/api/auth/me` 答 404，前端先于 BFF 上线时交接接口还不存在，
 * `AbortSignal.timeout(5000)` 让「API 慢」与「API 挂了」同形。这些情况下正常挂载应用——
 * 本地数据已经搬过来了，访客看到的是自己的东西，只是没自动登录。回退旧站留给
 * `main.tsx` 里「本地导入真的没成」那一条路径。
 */
export async function restoreLogin(
  config: CompatibilityConfig,
  apiOrigin: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (location.origin !== config.targetOrigin) return true
  try {
    const url = new URL(location.href)
    const get = (path: string) =>
      fetcher(`${apiOrigin.replace(/\/$/, '')}${path}`, {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
    if (url.searchParams.has(CALLBACK)) {
      url.searchParams.delete(CALLBACK)
      url.searchParams.delete('__legacy')
      history.replaceState(history.state, '', url.pathname + url.search + url.hash)
      const receipt = await get('/api/auth/domain/available')
      if (receipt.ok && (await receipt.json()).completed === true) {
        localStorage.setItem(DONE, config.sourceOrigin)
        return true
      }
    }
    if (localStorage.getItem(DONE) === config.sourceOrigin) return true
    const me = await get('/api/auth/me')
    if (me.ok) {
      localStorage.setItem(DONE, config.sourceOrigin)
      return true
    }
    // 401 之外的答复不代表交接坏了，多半是这个部署根本没开登录。照常挂载。
    if (me.status !== 401) return true
    const available = await get('/api/auth/domain/available')
    // 交接关着或答不上来：不做交接，也不弹走。
    if (!available.ok || !(await available.json()).enabled) return true
    url.searchParams.delete('__legacy')
    const returnPath = url.pathname + url.search + url.hash
    location.replace(
      `${apiOrigin.replace(/\/$/, '')}/api/auth/domain/start?return=${encodeURIComponent(returnPath)}`,
    )
  } catch {
    // 网络错误、超时、JSON 坏了——都只说明这一次接不上登录，不说明数据有问题。
    return true
  }
  return false
}
