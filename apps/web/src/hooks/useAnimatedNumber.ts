import { useEffect, useRef, useState } from 'react'

export type NumberDirection = 'up' | 'down' | null

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 实时数值平滑过渡（用于积分余额等会在使用过程中发生增减的数字）：
 * - 首次到达或从 null 变为数值时直接显示，不做“从 0 滚上来”的装饰动画。
 * - 后续数值变化时按 ease-out 顺滑过渡，途中再次变化自动从当前显示值接续。
 * - 遵守 prefers-reduced-motion: reduce。
 */
export function useAnimatedNumber(
  target: number | null,
  durationMs = 320,
): { display: number | null; direction: NumberDirection } {
  const [display, setDisplay] = useState<number | null>(target)
  const [direction, setDirection] = useState<NumberDirection>(null)
  const currentRef = useRef<number | null>(target)

  useEffect(() => {
    const previous = currentRef.current
    if (target === null) {
      currentRef.current = null
      setDisplay(null)
      setDirection(null)
      return
    }
    if (previous === null || previous === target) {
      currentRef.current = target
      setDisplay(target)
      setDirection(null)
      return
    }

    const nextDirection: NumberDirection = target > previous ? 'up' : 'down'
    setDirection(nextDirection)
    const clearTimer = window.setTimeout(() => setDirection(null), Math.max(480, durationMs + 160))

    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      currentRef.current = target
      setDisplay(target)
      return () => window.clearTimeout(clearTimer)
    }

    const from = previous
    const delta = target - from
    const startedAt = performance.now()
    let frameId = 0

    const step = (now: number) => {
      const elapsed = now - startedAt
      const progress = Math.min(1, elapsed / durationMs)
      const eased = 1 - (1 - progress) ** 3
      const next = progress >= 1 ? target : Math.round(from + delta * eased)
      currentRef.current = next
      setDisplay(next)
      if (progress < 1) {
        frameId = requestAnimationFrame(step)
      }
    }

    frameId = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frameId)
      window.clearTimeout(clearTimer)
    }
  }, [target, durationMs])

  return { display, direction }
}
