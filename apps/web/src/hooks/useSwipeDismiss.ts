import { type TouchEvent as ReactTouchEvent, useCallback, useRef, useState } from 'react'

const LOCK_THRESHOLD_PX = 10
const DISMISS_DISTANCE_PX = 100
const DISMISS_VELOCITY_PX_MS = 0.55
/** 超过这个停顿窗口松手不再沿用旧速度，避免“快速短拖→停住→松手”误关。 */
const VELOCITY_STALE_MS = 100

function hasHorizontalScrollableAncestor(
  target: EventTarget | null,
  boundary: HTMLElement,
): boolean {
  let node = target instanceof HTMLElement ? target : null
  while (node && node !== boundary) {
    const style = window.getComputedStyle(node)
    if (
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + 1
    ) {
      return true
    }
    node = node.parentElement
  }
  return false
}

/**
 * 右侧抽屉 1:1 跟手右滑关闭手势：
 * - 横向位移超过阈值且明显大于纵向位移时锁定手势，避免影响抽屉内部纵向滚动。
 * - 遇到多指触摸立即取消并复位；释放时过滤已过期的历史速度，按距离或有效抛掷速度决定关闭或回弹。
 */
export function useSwipeDismiss(onDismiss: () => void) {
  const [offsetX, setOffsetX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const gestureRef = useRef<{
    active: boolean
    locked: 'none' | 'horizontal' | 'vertical'
    startX: number
    startY: number
    lastX: number
    lastTime: number
    velocityX: number
    width: number
  }>({
    active: false,
    locked: 'none',
    startX: 0,
    startY: 0,
    lastX: 0,
    lastTime: 0,
    velocityX: 0,
    width: 0,
  })

  const reset = useCallback(() => {
    gestureRef.current.active = false
    gestureRef.current.locked = 'none'
    gestureRef.current.velocityX = 0
    setDragging(false)
    setOffsetX(0)
  }, [])

  const onTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      if (event.touches.length !== 1) {
        if (gestureRef.current.active) reset()
        return
      }
      // Portal 弹层（如抽屉内打开的 ImagePreview）的合成事件会沿 Fiber 树冒泡，必须校验真实 DOM 包含关系。
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return
      if (hasHorizontalScrollableAncestor(event.target, event.currentTarget)) return
      const touch = event.touches[0]
      gestureRef.current = {
        active: true,
        locked: 'none',
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastTime: performance.now(),
        velocityX: 0,
        width: event.currentTarget.getBoundingClientRect().width || 360,
      }
    },
    [reset],
  )

  const onTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      const g = gestureRef.current
      if (!g.active) return
      if (event.touches.length !== 1) {
        reset()
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - g.startX
      const dy = touch.clientY - g.startY

      if (g.locked === 'none') {
        if (Math.hypot(dx, dy) < LOCK_THRESHOLD_PX) return
        if (dx > 0 && dx > Math.abs(dy) * 1.25) {
          g.locked = 'horizontal'
          setDragging(true)
        } else {
          g.locked = 'vertical'
          g.active = false
          return
        }
      }

      if (g.locked !== 'horizontal') return
      const now = performance.now()
      const dt = Math.max(1, now - g.lastTime)
      g.velocityX = (touch.clientX - g.lastX) / dt
      g.lastX = touch.clientX
      g.lastTime = now
      setOffsetX(Math.max(0, dx))
    },
    [reset],
  )

  const onTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      if (event.touches.length > 0) return
      const g = gestureRef.current
      if (!g.active || g.locked !== 'horizontal') {
        reset()
        return
      }
      const distance = Math.max(0, g.lastX - g.startX)
      const effectiveVelocityX =
        performance.now() - g.lastTime <= VELOCITY_STALE_MS ? g.velocityX : 0
      const shouldDismiss =
        distance >= Math.min(DISMISS_DISTANCE_PX, g.width * 0.3) ||
        effectiveVelocityX >= DISMISS_VELOCITY_PX_MS
      reset()
      if (shouldDismiss) onDismiss()
    },
    [onDismiss, reset],
  )

  const progress = offsetX > 0 ? Math.min(1, offsetX / 280) : 0

  return {
    offsetX,
    dragging,
    backdropOpacity: dragging ? Math.max(0.2, 1 - progress * 0.75) : undefined,
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: reset,
    },
  }
}
