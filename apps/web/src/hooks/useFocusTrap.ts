import { type RefObject, useEffect, useRef } from 'react'

const CANDIDATES =
  'a[href], button, input:not([type="hidden"]), select, textarea, [contenteditable="true"], [tabindex]'

/** 当前已打开的陷阱，只有栈顶那层接管 Tab；嵌套弹窗关闭后焦点回到下面那层。 */
const trapStack: Array<RefObject<HTMLElement | null>> = []

/** 按 Tab 顺序能落到的元素：排除禁用、tabIndex<0、inert 子树和不可见的。 */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(CANDIDATES)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.closest('[inert]') &&
      el.getClientRects().length > 0,
  )
}

function focusContainer(container: HTMLElement) {
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1')
  container.focus({ preventScroll: true })
}

/**
 * 模态打开时把焦点放进容器、Tab 只在容器内循环，关闭时把焦点还给打开前的元素。
 * 容器里已有元素抢先聚焦（autoFocus）时不覆盖它。
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, enabled = true) {
  // 在渲染时记下打开者：子组件的 autoFocus 发生在 effect 之前，等到 effect 再读就已经是弹窗里的元素了。
  const openerRef = useRef<HTMLElement | null | undefined>(undefined)
  if (enabled && openerRef.current === undefined && typeof document !== 'undefined') {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  useEffect(() => {
    if (!enabled) return
    const container = containerRef.current
    if (!container) return
    const opener = openerRef.current
    openerRef.current = undefined
    trapStack.push(containerRef)

    if (!container.contains(document.activeElement)) {
      const first = tabbables(container)[0]
      if (first) first.focus({ preventScroll: true })
      else focusContainer(container)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      if (trapStack[trapStack.length - 1] !== containerRef) return
      const items = tabbables(container)
      if (items.length === 0) {
        event.preventDefault()
        focusContainer(container)
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = trapStack.indexOf(containerRef)
      const wasTop = index === trapStack.length - 1
      trapStack.splice(index, 1)
      // 下层先关时不动焦点：焦点还在上层弹窗里。
      if (!wasTop) return
      const below = trapStack[trapStack.length - 1]?.current
      if (opener?.isConnected && (!below || below.contains(opener))) {
        opener.focus({ preventScroll: true })
      } else if (below) {
        const target = tabbables(below)[0]
        if (target) target.focus({ preventScroll: true })
        else focusContainer(below)
      }
    }
  }, [containerRef, enabled])
}
