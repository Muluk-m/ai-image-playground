import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

const FLIP_DURATION_MS = 240
const FLIP_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
const MAX_FLIP_ITEMS = 36
const MAX_FULL_MEASURE = 64
const MAX_VISIBLE_MEASURE = 48
const VIEWPORT_MARGIN_PX = 160
const SCROLL_SNAPSHOT_DEBOUNCE_MS = 120

interface ContentPoint {
  left: number
  top: number
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function canUseWaapi(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

/**
 * 大列表（未虚拟化）用二分定位视口附近首个元素，再向后采样有限窗口，
 * 避免在阻塞绘制的 `useLayoutEffect` 里对几百上千张卡片全量 `getBoundingClientRect`。
 */
function selectCandidateNodes(nodes: readonly HTMLElement[], viewportH: number): HTMLElement[] {
  if (nodes.length <= MAX_FULL_MEASURE) return nodes as HTMLElement[]

  let lo = 0
  let hi = nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (nodes[mid]!.getBoundingClientRect().bottom < -VIEWPORT_MARGIN_PX) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  const start = Math.max(0, lo - 6)
  const end = Math.min(nodes.length, start + MAX_VISIBLE_MEASURE)
  const slice: HTMLElement[] = []
  for (let i = start; i < end; i++) {
    const el = nodes[i]!
    if (i > lo && el.getBoundingClientRect().top > viewportH + VIEWPORT_MARGIN_PX) break
    slice.push(el)
  }
  return slice
}

/**
 * 轻量级列表/网格 FLIP 重排补位：
 * - 新项插入、删除或筛选重排时，让留在列表里的相邻卡片平滑滑到新坐标，不再瞬间跳格。
 * - 使用相对容器内容原点的坐标（含 container.scrollLeft/scrollTop），window 滚动与内部滚动容器均不误触。
 * - `snapshotKey` 可选：虚拟列表滚动导致可见行挂载变化时仅刷新快照、不触发补位动画，避免滚到底部后删卡缺少前态。
 * - 途中再次重排时，`useLayoutEffect` 运行在 React 提交新布局 `content` 之后；旧动画仍在合成层叠加残留位移，
 *   因此 `visualBeforeCancel = content + residualOffset`，推回上一帧真实视觉起点 `prev + (visualBeforeCancel - content)`。
 * - 遵守 `prefers-reduced-motion: reduce`（直接早退，零同步布局读取）；视口宽度变化或超视口大跳变时跳过。
 */
export function useFlipList(
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string,
  keyAttr: string,
  orderKey: string,
  snapshotKey?: string,
): void {
  const prevRectsRef = useRef<Map<string, ContentPoint>>(new Map())
  const prevViewportWidthRef = useRef<number>(0)
  const prevOrderKeyRef = useRef<string | null>(null)
  const hasLargeListRef = useRef<boolean>(false)
  const animationsRef = useRef<WeakMap<HTMLElement, Animation>>(new WeakMap())

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || typeof window === 'undefined' || prefersReducedMotion() || !canUseWaapi()) {
      prevRectsRef.current = new Map()
      prevOrderKeyRef.current = orderKey
      hasLargeListRef.current = false
      return
    }

    const viewportW = window.innerWidth
    const viewportH = window.innerHeight || 900
    const prevRects = prevRectsRef.current
    const viewportChanged =
      prevViewportWidthRef.current > 0 && prevViewportWidthRef.current !== viewportW
    const orderChanged = prevOrderKeyRef.current !== null && prevOrderKeyRef.current !== orderKey
    prevOrderKeyRef.current = orderKey

    const allNodes = [...container.querySelectorAll<HTMLElement>(itemSelector)]
    hasLargeListRef.current = allNodes.length > MAX_FULL_MEASURE
    const nodes = selectCandidateNodes(allNodes, viewportH)
    const canAnimate = orderChanged && !viewportChanged && prevRects.size > 0

    const cRectBefore = container.getBoundingClientRect()
    const scrollLeft = container.scrollLeft
    const scrollTop = container.scrollTop

    // 仅快照刷新（如虚拟列表滚动切行，`orderKey` 未变）：不打断在途补位动画，
    // 且对正在动画的卡片保留其真实布局基准，避免把残留 translate3d 写进 prevRects。
    if (!orderChanged && prevRects.size > 0 && !viewportChanged) {
      const nextRects = new Map<string, ContentPoint>()
      for (const el of nodes) {
        const key = el.getAttribute(keyAttr)
        if (!key) continue
        const running = animationsRef.current.get(el)
        if (running && running.playState === 'running') {
          const existing = prevRects.get(key)
          if (existing) nextRects.set(key, existing)
          continue
        }
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        nextRects.set(key, {
          left: rect.left - cRectBefore.left + scrollLeft,
          top: rect.top - cRectBefore.top + scrollTop,
        })
      }
      prevRectsRef.current = nextRects
      prevViewportWidthRef.current = viewportW
      return
    }

    // 1. 批量读：对仍在播放旧 FLIP 动画的卡片记录 cancel 前的 `content + residualOffset`。
    const activeNodes: HTMLElement[] = []
    const visualBeforeCancel = new Map<string, ContentPoint>()
    for (const el of nodes) {
      const running = animationsRef.current.get(el)
      if (!running || running.playState !== 'running') continue
      const key = el.getAttribute(keyAttr)
      if (key) {
        const visualRect = el.getBoundingClientRect()
        if (visualRect.width > 0 && visualRect.height > 0) {
          visualBeforeCancel.set(key, {
            left: visualRect.left - cRectBefore.left + scrollLeft,
            top: visualRect.top - cRectBefore.top + scrollTop,
          })
        }
      }
      activeNodes.push(el)
    }

    // 2. 批量取消旧动画，确保随后读取到的是不受旧 translate3d 影响的真实布局坐标。
    for (const el of activeNodes) {
      animationsRef.current.get(el)?.cancel()
      animationsRef.current.delete(el)
    }

    // 3. 批量读真实布局坐标：写入下一轮基准并计算需要补位的可见卡片位移。
    const cRect = activeNodes.length > 0 ? container.getBoundingClientRect() : cRectBefore
    const nextRects = new Map<string, ContentPoint>()
    const moves: Array<{ el: HTMLElement; dx: number; dy: number }> = []

    for (const el of nodes) {
      const key = el.getAttribute(keyAttr)
      if (!key) continue
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue

      const inViewport =
        rect.bottom >= -VIEWPORT_MARGIN_PX && rect.top <= viewportH + VIEWPORT_MARGIN_PX
      const contentLeft = rect.left - cRect.left + scrollLeft
      const contentTop = rect.top - cRect.top + scrollTop
      nextRects.set(key, { left: contentLeft, top: contentTop })

      if (!canAnimate || !inViewport || moves.length >= MAX_FLIP_ITEMS) continue
      const prev = prevRects.get(key)
      if (!prev) continue

      // `visualBeforeCancel = content + residualOffset`，故 `residualOffset = visualBeforeCancel - content`；
      // 叠加回上一轮布局 `prev` 即为本次重排发生瞬间该卡片的真实视觉坐标。
      const visual = visualBeforeCancel.get(key)
      const originLeft = visual ? prev.left + (visual.left - contentLeft) : prev.left
      const originTop = visual ? prev.top + (visual.top - contentTop) : prev.top

      const dx = originLeft - contentLeft
      const dy = originTop - contentTop
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      if (Math.abs(dy) > viewportH * 1.5 || Math.abs(dx) > viewportW * 1.2) continue

      moves.push({ el, dx, dy })
    }

    prevRectsRef.current = nextRects
    prevViewportWidthRef.current = viewportW

    if (moves.length === 0) return

    // 4. 批量写：合成层 `translate3d` 平滑滑向最终落位。
    for (const { el, dx, dy } of moves) {
      const anim = el.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
        {
          duration: FLIP_DURATION_MS,
          easing: FLIP_EASING,
        },
      )
      animationsRef.current.set(el, anim)
    }
  }, [containerRef, itemSelector, keyAttr, orderKey, snapshotKey])

  // 未虚拟化的大列表滚动停止后刷新视口切片快照，保证滚到下方再删卡也有准确前态。
  useEffect(() => {
    if (typeof window === 'undefined' || prefersReducedMotion() || !canUseWaapi()) return
    let timer: number | null = null
    const refreshSnapshot = () => {
      if (!hasLargeListRef.current || prefersReducedMotion()) return
      const container = containerRef.current
      if (!container) return
      const viewportH = window.innerHeight || 900
      const allNodes = [...container.querySelectorAll<HTMLElement>(itemSelector)]
      hasLargeListRef.current = allNodes.length > MAX_FULL_MEASURE
      const nodes = selectCandidateNodes(allNodes, viewportH)
      const cRect = container.getBoundingClientRect()
      const scrollLeft = container.scrollLeft
      const scrollTop = container.scrollTop
      const prevRects = prevRectsRef.current
      const nextRects = new Map<string, ContentPoint>()
      for (const el of nodes) {
        const key = el.getAttribute(keyAttr)
        if (!key) continue
        const running = animationsRef.current.get(el)
        if (running && running.playState === 'running') {
          const existing = prevRects.get(key)
          if (existing) nextRects.set(key, existing)
          continue
        }
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        nextRects.set(key, {
          left: rect.left - cRect.left + scrollLeft,
          top: rect.top - cRect.top + scrollTop,
        })
      }
      prevRectsRef.current = nextRects
    }
    const onScroll = (event: Event) => {
      if (!hasLargeListRef.current) return
      const container = containerRef.current
      if (!container) return
      const target = event.target
      if (
        target !== document &&
        target !== window &&
        target instanceof Node &&
        !target.contains(container) &&
        !container.contains(target)
      ) {
        return
      }
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(refreshSnapshot, SCROLL_SNAPSHOT_DEBOUNCE_MS)
    }
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      if (timer != null) window.clearTimeout(timer)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [containerRef, itemSelector, keyAttr])
}
