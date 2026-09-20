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

/** Storage is committed before navigating; no session credential is exposed to JavaScript. */
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
    if (me.status !== 401) throw new Error('Session unavailable')
    const available = await get('/api/auth/domain/available')
    if (!available.ok || !(await available.json()).enabled) throw new Error('Handoff unavailable')
    url.searchParams.delete('__legacy')
    const returnPath = url.pathname + url.search + url.hash
    location.replace(
      `${apiOrigin.replace(/\/$/, '')}/api/auth/domain/start?return=${encodeURIComponent(returnPath)}`,
    )
  } catch {
    location.replace(legacyFallback(config))
  }
  return false
}
