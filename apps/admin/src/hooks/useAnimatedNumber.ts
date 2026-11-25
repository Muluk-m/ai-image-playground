import { useEffect, useRef, useState } from 'react'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 实时数值平滑过渡（用于 Admin 看板 KPI 等随时间范围或刷新变动的指标数字）：
 * - 首次渲染或从 null 到达时直接显示，不做从 0 滚起的装饰动画。
 * - 后续变动按 ease-out 平滑插值，途中再次变动自动从当前显示值接续。
 * - 遵守 prefers-reduced-motion: reduce。
 */
export function useAnimatedNumber(
  target: number | null,
  durationMs = 280,
  decimals = 0,
): number | null {
  const [display, setDisplay] = useState<number | null>(target)
  const currentRef = useRef<number | null>(target)

  useEffect(() => {
    const previous = currentRef.current
    if (target === null || !Number.isFinite(target)) {
      currentRef.current = null
      setDisplay(null)
      return
    }
    if (previous === null || previous === target) {
      currentRef.current = target
      setDisplay(target)
      return
    }
    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      currentRef.current = target
      setDisplay(target)
      return
    }

    const from = previous
    const delta = target - from
    const factor = 10 ** Math.max(0, decimals)
    const startedAt = performance.now()
    let frameId = 0

    const step = (now: number) => {
      const progress =
        durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (now - startedAt) / durationMs))
      const eased = 1 - (1 - progress) ** 3
      const raw = progress >= 1 ? target : Math.round((from + delta * eased) * factor) / factor
      const next = raw === 0 ? 0 : raw
      currentRef.current = next
      setDisplay(next)
      if (progress < 1) {
        frameId = requestAnimationFrame(step)
      }
    }

    frameId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frameId)
  }, [target, durationMs, decimals])

  return display
}
