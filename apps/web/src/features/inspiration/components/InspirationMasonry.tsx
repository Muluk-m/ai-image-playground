import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { ratioForItem, rememberRatio } from '../lib/imageRatio'
import { layoutMasonry, MASONRY_BATCH, MASONRY_GAP, MASONRY_GAP_COMPACT } from '../lib/masonry'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import InspirationCard from './InspirationCard'
import { InspirationPagingSkeleton } from './InspirationSkeleton'

interface Props {
  items: InspirationItem[]
  scroller: HTMLElement | null
  resetKey: string
}

export default function InspirationMasonry({ items, scroller, resetKey }: Props) {
  const showDetail = useInspirationStore((s) => s.showDetail)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)
  const { t } = useTranslation('inspiration')
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [compact, setCompact] = useState(false)
  const [visibleCount, setVisibleCount] = useState(MASONRY_BATCH)
  const [paging, setPaging] = useState(false)
  const [ratioTick, setRatioTick] = useState(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const pagingLock = useRef(false)

  useEffect(() => {
    setVisibleCount(MASONRY_BATCH)
    setPaging(false)
    pagingLock.current = false
  }, [resetKey])

  useLayoutEffect(() => {
    if (!node) return
    const measure = () => {
      setWidth(node.clientWidth)
      setCompact(window.matchMedia('(max-width: 767px)').matches)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  const visible = items.slice(0, visibleCount)
  const gap = compact ? MASONRY_GAP_COMPACT : MASONRY_GAP
  const layout = useMemo(
    () => layoutMasonry(width, visible.map(ratioForItem), gap),
    [width, visible, gap, ratioTick],
  )

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (pagingLock.current) return
        if (visibleCount >= items.length) return
        pagingLock.current = true
        setPaging(true)
        setVisibleCount((count) => Math.min(items.length, count + MASONRY_BATCH))
        requestAnimationFrame(() => {
          pagingLock.current = false
          setPaging(false)
        })
      },
      { root: scroller, rootMargin: '0px 0px 600px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [scroller, visibleCount, items.length])

  const reachedEnd = visibleCount >= items.length && items.length > 0

  return (
    <div data-testid="inspiration-feed">
      <div
        ref={setNode}
        className="relative"
        style={{ height: layout.height }}
        data-columns={layout.columns}
      >
        {layout.boxes.map((box) => {
          const item = visible[box.index]
          if (!item) return null
          return (
            <div
              key={item.id}
              className="absolute"
              style={{ left: box.x, top: box.y, width: box.width }}
            >
              <InspirationCard
                item={item}
                pinned={pinnedSet.has(item.id)}
                imageHeight={box.imageHeight}
                onClick={() => showDetail(item.id)}
                onMeasured={(measuredWidth, measuredHeight) => {
                  const next = rememberRatio(item.id, measuredWidth, measuredHeight)
                  const previous = box.imageHeight / Math.max(box.width, 1)
                  if (Math.abs(next - previous) > 0.001) setRatioTick((tick) => tick + 1)
                }}
              />
            </div>
          )
        })}
      </div>
      <div ref={sentinelRef} className="min-h-4" />
      {paging ? <InspirationPagingSkeleton columns={layout.columns} /> : null}
      {reachedEnd ? (
        <div className="flex items-center justify-center gap-3 py-8 text-label-sm text-muted-foreground">
          <span className="h-px w-10 bg-border" />
          <span>{t('list.end', { count: items.length })}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => scroller?.scrollTo({ top: 0 })}
          >
            <Icon name="chevronUp" />
            {t('list.backToTop')}
          </Button>
          <span className="h-px w-10 bg-border" />
        </div>
      ) : null}
    </div>
  )
}
