import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react'

const DEFAULT_ACTIVE_SELECTOR =
  '[aria-pressed="true"], [aria-selected="true"], [data-state="on"], [data-active="true"]'

interface IndicatorRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 测量容器内当前选中项的几何位置，驱动一颗 GPU 合成的滑动背景胶囊。
 *
 * - 首次测量直接落位，不从左上角飞入；后续切换平滑滑动，途中再点可随时改道。
 * - 无布局环境（jsdom / 隐藏容器）返回 `visible: false`，按钮自动保留静态高亮兜底。
 */
export function useSlidingIndicator(
  activeKey: string | number | null | undefined,
  selector = DEFAULT_ACTIVE_SELECTOR,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<IndicatorRect | null>(null)
  const [animated, setAnimated] = useState(false)
  const animatedRef = useRef(false)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || activeKey == null) {
      animatedRef.current = false
      setAnimated(false)
      setRect(null)
      return
    }

    let frameId: number | null = null
    const measure = () => {
      const target = container.querySelector<HTMLElement>(selector)
      if (!target || target.offsetWidth <= 0 || target.offsetHeight <= 0) {
        setRect(null)
        return
      }
      const next: IndicatorRect = {
        left: target.offsetLeft,
        top: target.offsetTop,
        width: target.offsetWidth,
        height: target.offsetHeight,
      }
      setRect((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      )
      if (!animatedRef.current && typeof requestAnimationFrame === 'function') {
        if (frameId != null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(frameId)
        }
        frameId = requestAnimationFrame(() => {
          animatedRef.current = true
          setAnimated(true)
        })
      }
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(container)
    const activeEl = container.querySelector<HTMLElement>(selector)
    if (activeEl) observer?.observe(activeEl)

    return () => {
      observer?.disconnect()
      if (frameId != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameId)
      }
    }
  }, [activeKey, selector])

  const visible = rect !== null
  const indicatorStyle: CSSProperties | undefined = rect
    ? {
        transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        transition: animated
          ? 'transform var(--motion-normal) var(--ease-in-out), width var(--motion-normal) var(--ease-in-out), height var(--motion-normal) var(--ease-in-out)'
          : 'none',
      }
    : undefined

  return { containerRef, indicatorStyle, visible }
}
