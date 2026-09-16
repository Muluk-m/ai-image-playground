/** UUIDs stay reversible so cloud projects can be opened before their list page is loaded. */
export function projectRouteSegment(id: string): string {
  if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) {
    const bytes = id
      .replaceAll('-', '')
      .match(/../g)!
      .map((hex) => Number.parseInt(hex, 16))
    return btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
  }
  // Legacy storage keys must remain unchanged; their address is resolved from the project catalog.
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(id)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return `l${hash.toString(36).padStart(13, '0')}`
}

export function resolveProjectRoute(id: string, projects: readonly { id: string }[]): string {
  const exact = projects.find((project) => project.id === id)
  if (exact) return exact.id
  const matches = projects.filter((project) => projectRouteSegment(project.id) === id)
  if (matches.length > 1) throw new Error('Ambiguous project address')
  return matches[0]?.id ?? id
}

/** Accept old escaped IDs as well as the compact canonical address. */
export function readProjectRoute(pathname = globalThis.location?.pathname ?? '/'): string | null {
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try {
    const segment = decodeURIComponent(match[1]!)
    if (/^[A-Za-z0-9_-]{22}$/.test(segment)) {
      const bytes = atob(segment.replaceAll('-', '+').replaceAll('_', '/') + '==')
      const hex = Array.from(bytes, (byte) =>
        byte.charCodeAt(0).toString(16).padStart(2, '0'),
      ).join('')
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      if (projectRouteSegment(id) === segment) return id
    }
    return segment || null
  } catch {
    return null
  }
}

export function writeProjectRoute(id: string, replace = false): void {
  if (typeof window === 'undefined') return
  const path = `/p/${projectRouteSegment(id)}`
  if (window.location.pathname === path) return
  const current = readProjectRoute()
  const canonicalizing = current === id || current === projectRouteSegment(id)
  window.history[replace || canonicalizing ? 'replaceState' : 'pushState'](
    null,
    '',
    `${path}${window.location.search}${window.location.hash}`,
  )
}
