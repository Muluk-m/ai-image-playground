import { useEffect, useRef } from 'react'

/** 离底部还有这么远就开始读下一页，滚到底时下一页已经在了。 */
export const LOAD_MORE_MARGIN = 240

/**
 * 列表末尾的哨兵：它进入「视口下沿再往下 `margin`」时调一次 `onNear`。
 * 只在 `enabled` 时观察；读完一页 `enabled` 会先变 false 再变回 true，哨兵仍在范围里就再读一页。
 */
export function useNearEnd<T extends Element>(
  onNear: () => void,
  enabled: boolean,
  margin = LOAD_MORE_MARGIN,
) {
  const ref = useRef<T>(null)
  const latest = useRef(onNear)
  latest.current = onNear
  useEffect(() => {
    const node = ref.current
    if (!node || !enabled) return
    if (typeof IntersectionObserver === 'undefined') {
      const check = () => {
        if (node.getBoundingClientRect().top <= window.innerHeight + margin) latest.current()
      }
      window.addEventListener('scroll', check, { passive: true })
      window.addEventListener('resize', check)
      check()
      return () => {
        window.removeEventListener('scroll', check)
        window.removeEventListener('resize', check)
      }
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) latest.current()
      },
      { rootMargin: `0px 0px ${margin}px 0px` },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, margin])
  return ref
}
