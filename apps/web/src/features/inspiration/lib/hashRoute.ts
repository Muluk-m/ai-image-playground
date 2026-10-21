import { useStore } from '../../../store'
import { useInspirationStore } from '../store'
import { onInspirationPage, openInspiration } from './navigate'

const LIST_HASH = '#inspirations'

export function isInspirationHash(hash = currentHash()): boolean {
  return hash === LIST_HASH || hash.startsWith(`${LIST_HASH}/`)
}

export function inspirationDetailIdFromHash(hash = currentHash()): string | null {
  if (!hash.startsWith(`${LIST_HASH}/`)) return null
  const raw = hash.slice(LIST_HASH.length + 1)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 详情打开、切换、关闭时改 hash。replaceState 不触发 hashchange。 */
export function writeInspirationHash(id: string | null): void {
  if (typeof window === 'undefined') return
  const { pathname, search } = window.location
  const next = id ? `${LIST_HASH}/${encodeURIComponent(id)}` : LIST_HASH
  if (window.location.hash === next) return
  window.history.replaceState(null, '', `${pathname}${search}${next}`)
}

export function inspirationShareUrl(id: string): string {
  const hash = `${LIST_HASH}/${encodeURIComponent(id)}`
  if (typeof window === 'undefined') return hash
  const { origin, pathname, search } = window.location
  return `${origin}${pathname}${search}${hash}`
}

function currentHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash
}

/** 已经停在探索详情上时，不要把 hash 收成不带 id 的列表。 */
function setHash(open: boolean) {
  if (typeof window === 'undefined') return
  const { pathname, search, hash } = window.location
  if (open) {
    if (!isInspirationHash(hash)) {
      window.history.replaceState(null, '', `${pathname}${search}${LIST_HASH}`)
    }
    return
  }
  if (isInspirationHash(hash)) window.history.replaceState(null, '', `${pathname}${search}`)
}

function waitUntilSettled(): Promise<void> {
  const status = useInspirationStore.getState().status
  if (status === 'ready' || status === 'error') return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useInspirationStore.subscribe((state) => {
      if (state.status !== 'ready' && state.status !== 'error') return
      unsubscribe()
      resolve()
    })
  })
}

/** 清单里有这条才打开详情。没有就只留在探索页，坏 hash 原样留着。 */
async function revealDetailFromHash(): Promise<void> {
  const id = inspirationDetailIdFromHash()
  const store = useInspirationStore.getState()
  if (!id) {
    store.closeDetail()
    return
  }
  if (store.status !== 'ready' && store.status !== 'error') {
    await store.loadRemote()
    await waitUntilSettled()
  }
  const settled = useInspirationStore.getState()
  if (settled.items.some((item) => item.id === id)) settled.showDetail(id)
  else settled.closeDetail()
}

let unsubscribe: Array<() => void> = []

export function disposeHashRoute() {
  for (const off of unsubscribe) off()
  unsubscribe = []
}

/**
 * hash ↔ 探索页双向同步。`#inspirations` 和 `#inspirations/<id>` 都是探索页；
 * 离开探索页时两种 hash 都清掉。
 */
export function initHashRoute() {
  if (typeof window === 'undefined') return

  disposeHashRoute()
  const sync = () => setHash(onInspirationPage())
  unsubscribe = [useStore.subscribe(sync)]

  const onHashChange = () => {
    if (isInspirationHash()) {
      if (!onInspirationPage()) openInspiration()
      void revealDetailFromHash()
      return
    }
    if (onInspirationPage()) useStore.getState().setAppMode('image')
  }
  window.addEventListener('hashchange', onHashChange)
  unsubscribe.push(() => window.removeEventListener('hashchange', onHashChange))

  if (!isInspirationHash()) return
  if (!onInspirationPage()) openInspiration()
  void revealDetailFromHash()
}
