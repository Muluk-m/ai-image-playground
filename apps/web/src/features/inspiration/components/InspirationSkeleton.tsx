import { useLayoutEffect, useState } from 'react'
import { layoutMasonry, MASONRY_GAP, MASONRY_GAP_COMPACT } from '../lib/masonry'

const PLACEHOLDER_RATIOS = [1.5, 1.25, 0.7, 1.33, 1, 1.5, 0.75, 1.2, 1.4, 0.66, 1.33, 1]

function useFeedWidth() {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    if (!node) return
    const measure = () => {
      setWidth(node.clientWidth)
      setCompact(
        typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches,
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return { setNode, width, gap: compact ? MASONRY_GAP_COMPACT : MASONRY_GAP }
}

/** 首屏还没有清单时的瀑布骨架，列数跟正式布局同一套。 */
export default function InspirationSkeleton({ label }: { label: string }) {
  const { setNode, width, gap } = useFeedWidth()
  const layout = layoutMasonry(width, PLACEHOLDER_RATIOS, gap)
  return (
    <div
      ref={setNode}
      className="relative"
      style={{ height: layout.height }}
      aria-busy="true"
      aria-label={label}
      data-testid="inspiration-loading"
      data-columns={layout.columns}
    >
      {layout.boxes.map((box) => (
        <div
          key={box.index}
          className="absolute"
          style={{ left: box.x, top: box.y, width: box.width }}
        >
          <div
            className="animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"
            style={{ height: box.imageHeight }}
          />
          <div className="mt-2 h-2.5 w-3/4 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="mt-1.5 h-2 w-1/2 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  )
}

export function InspirationPagingSkeleton({ columns }: { columns: number }) {
  const heights = [220, 300, 180, 260, 240, 200]
  return (
    <div
      className="mt-3 grid gap-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      data-testid="inspiration-paging"
      aria-hidden="true"
    >
      {Array.from({ length: columns }, (_, index) => (
        <div
          key={index}
          className="animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"
          style={{ height: heights[index % heights.length] }}
        />
      ))}
    </div>
  )
}
