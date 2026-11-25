import { type RefObject, useLayoutEffect, useRef } from 'react'

const FLIP_DURATION_MS = 240
const FLIP_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
const MAX_FLIP_ITEMS = 36
const VIEWPORT_MARGIN_PX = 160

interface ContentPoint {
  left: number
  top: number
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 轻量级列表/网格 FLIP 重排补位：
 * - 新项插入、删除或筛选重排时，让留在列表里的相邻卡片平滑滑到新坐标，不再瞬间跳格。
 * - 使用相对容器内容原点的坐标（含 container.scrollLeft/scrollTop），window 滚动与内部滚动容器均不误触。
 * - 途中再次重排先采集当前视觉位置、取消旧动画，再读真实布局写入基准，既丝滑衔接又不污染基准坐标。
 * - 遵守 `prefers-reduced-motion: reduce`，视口宽度变化或超视口大跳变时自动跳过。
 */
export function useFlipList(
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string,
  keyAttr: string,
  orderKey: string,
): void {
  const prevRectsRef = useRef<Map<string, ContentPoint>>(new Map())
  const prevViewportWidthRef = useRef<number>(0)
  const animationsRef = useRef<WeakMap<HTMLElement, Animation>>(new WeakMap())

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || typeof window === 'undefined') {
      prevRectsRef.current = new Map()
      return
    }

    const viewportW = window.innerWidth
    const viewportH = window.innerHeight || 900
    const prevRects = prevRectsRef.current
    const viewportChanged =
      prevViewportWidthRef.current > 0 && prevViewportWidthRef.current !== viewportW

    const nodes = [...container.querySelectorAll<HTMLElement>(itemSelector)]
    const canAnimate =
      !viewportChanged &&
      prevRects.size > 0 &&
      !prefersReducedMotion() &&
      typeof Element !== 'undefined' &&
      typeof Element.prototype.animate === 'function'

    const cRectBefore = container.getBoundingClientRect()
    const scrollLeft = container.scrollLeft
    const scrollTop = container.scrollTop

    // 1. 批量读：对仍在播放旧 FLIP 动画的卡片先记下它的当前视觉起点，保证连击/快速筛选无缝衔接。
    const activeNodes: HTMLElement[] = []
    const liveVisualPoints = new Map<string, ContentPoint>()
    for (const el of nodes) {
      const running = animationsRef.current.get(el)
      if (!running || running.playState !== 'running') continue
      const key = el.getAttribute(keyAttr)
      if (key) {
        const visualRect = el.getBoundingClientRect()
        if (visualRect.width > 0 && visualRect.height > 0) {
          liveVisualPoints.set(key, {
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
      const origin = liveVisualPoints.get(key) ?? prevRects.get(key)
      if (!origin) continue

      const dx = origin.left - contentLeft
      const dy = origin.top - contentTop
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
  }, [containerRef, itemSelector, keyAttr, orderKey])
}
