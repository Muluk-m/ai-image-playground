/** Stable project addresses; legacy IDs can contain colons, slashes and non-ASCII text. */
export function readProjectRoute(pathname = globalThis.location?.pathname ?? '/'): string | null {
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!) || null
  } catch {
    return null
  }
}

export function writeProjectRoute(id: string, replace = false): void {
  if (typeof window === 'undefined') return
  const path = `/p/${encodeURIComponent(id)}`
  if (window.location.pathname === path) return
  window.history[replace ? 'replaceState' : 'pushState'](
    null,
    '',
    `${path}${window.location.search}${window.location.hash}`,
  )
}
