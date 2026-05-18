import { useInspirationStore } from '../store'

const HASH = '#inspirations'

/**
 * 设置或清除 location.hash 为 #inspirations，不重新触发 hashchange。
 */
function setHash(open: boolean) {
  if (typeof window === 'undefined') return
  if (open) {
    if (window.location.hash !== HASH) {
      const { pathname, search } = window.location
      window.history.replaceState(null, '', `${pathname}${search}${HASH}`)
    }
  } else if (window.location.hash === HASH) {
    const { pathname, search } = window.location
    window.history.replaceState(null, '', `${pathname}${search}`)
  }
}

let unsubscribePanelOpen: (() => void) | null = null
let removeHashListener: (() => void) | null = null

/**
 * 启动 hash ↔ panelOpen 双向同步：
 * - panelOpen 变化 → 同步 hash
 * - 用户/链接修改 hash → 反向 open/close panel
 * - 初次调用时，若当前 hash 为 #inspirations，则自动 open
 */
export function initHashRoute() {
  if (typeof window === 'undefined') return

  // 卸载旧订阅（HMR / 重复 init 防御）
  unsubscribePanelOpen?.()
  removeHashListener?.()

  unsubscribePanelOpen = useInspirationStore.subscribe((state, prev) => {
    if (state.panelOpen !== prev.panelOpen) setHash(state.panelOpen)
  })

  const onHashChange = () => {
    const wantOpen = window.location.hash === HASH
    const state = useInspirationStore.getState()
    if (wantOpen && !state.panelOpen) state.openPanel()
    if (!wantOpen && state.panelOpen) state.closePanel()
  }
  window.addEventListener('hashchange', onHashChange)
  removeHashListener = () => window.removeEventListener('hashchange', onHashChange)

  // 初次检查
  if (window.location.hash === HASH) {
    const state = useInspirationStore.getState()
    if (!state.panelOpen) state.openPanel()
  }
}
