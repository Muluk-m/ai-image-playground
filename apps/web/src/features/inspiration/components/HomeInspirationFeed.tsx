import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useWindowVirtualizer } from '../../../hooks/useWindowVirtualizer'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { ratioForItem } from '../lib/imageRatio'
import {
  columnsForWidth,
  MASONRY_BATCH,
  MASONRY_CAPTION_HEIGHT,
  MASONRY_GAP,
  MASONRY_GAP_COMPACT,
} from '../lib/masonry'
import { openInspiration } from '../lib/navigate'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import InspirationCard from './InspirationCard'
import { InspirationPagingSkeleton } from './InspirationSkeleton'

const LOAD_MARGIN = 600

interface Props {
  items: InspirationItem[]
}

function useCompact(): boolean {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia('(max-width: 767px)')
    const apply = () => setCompact(list.matches)
    apply()
    list.addEventListener('change', apply)
    return () => list.removeEventListener('change', apply)
  }, [])
  return compact
}

/**
 * 首页灵感瀑布。滚动模型和作品网格是同一个 `useWindowVirtualizer`：
 * 作品按行虚拟化，这里用它的 lanes 做最短列。卡片只挂视口附近的，
 * 滚近底部再展开下一批，避免一上来把整份清单塞进 DOM。
 */
export default function HomeInspirationFeed({ items }: Props) {
  const showDetail = useInspirationStore((state) => state.showDetail)
  const pinnedIds = useStore((state) => state.pinnedInspirationIds)
  const { t } = useTranslation('inspiration')
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const compact = useCompact()
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [loaded, setLoaded] = useState(() => Math.min(MASONRY_BATCH, items.length))
  const [paging, setPaging] = useState(false)
  const [ratioTick, setRatioTick] = useState(0)
  const [scrollMargin, setScrollMargin] = useState(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const requested = useRef(loaded)
  const orderKey = `${items.length}:${items[0]?.id ?? ''}:${items[items.length - 1]?.id ?? ''}`
  const orderKeyRef = useRef(orderKey)

  useEffect(() => {
    if (orderKeyRef.current === orderKey) return
    orderKeyRef.current = orderKey
    const next = Math.min(MASONRY_BATCH, items.length)
    requested.current = next
    setLoaded(next)
    setPaging(false)
  }, [orderKey, items.length])

  useEffect(() => {
    if (!paging) return
    const frame = requestAnimationFrame(() => setPaging(false))
    return () => cancelAnimationFrame(frame)
  }, [paging, loaded])

  useLayoutEffect(() => {
    if (!node) return
    const measure = () => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  useLayoutEffect(() => {
    if (!node) return
    const top = Math.round(node.getBoundingClientRect().top + window.scrollY)
    setScrollMargin((current) => (Math.abs(top - current) > 1 ? top : current))
  })

  const gap = compact ? MASONRY_GAP_COMPACT : MASONRY_GAP
  const columns = width > 0 ? columnsForWidth(width) : 2
  const columnWidth = width > 0 ? Math.max(0, (width - gap * (columns - 1)) / columns) : 0
  const estimateSize = useCallback(
    (index: number) => {
      const item = items[index]
      if (!item || index >= loaded || columnWidth <= 0) return MASONRY_CAPTION_HEIGHT + 240
      return columnWidth * ratioForItem(item) + MASONRY_CAPTION_HEIGHT
    },
    [items, loaded, columnWidth, ratioTick],
  )
  const getItemKey = useCallback(
    (index: number) => (index < loaded ? (items[index]?.id ?? index) : index),
    [items, loaded],
  )
  const virtualizer = useWindowVirtualizer({
    count: columnWidth > 0 ? loaded : 0,
    estimateSize,
    gap,
    lanes: columns,
    overscan: columns * 2,
    scrollMargin,
    getItemKey,
  })

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    let cancelled = false
    const pump = () => {
      if (cancelled || requested.current !== loaded || loaded >= items.length) return
      if (sentinel.getBoundingClientRect().top > window.innerHeight + LOAD_MARGIN) return
      const next = Math.min(items.length, loaded + MASONRY_BATCH)
      requested.current = next
      setPaging(true)
      setLoaded(next)
    }
    if (typeof IntersectionObserver === 'undefined') {
      window.addEventListener('scroll', pump, { passive: true })
      window.addEventListener('resize', pump)
      return () => {
        cancelled = true
        window.removeEventListener('scroll', pump)
        window.removeEventListener('resize', pump)
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) pump()
      },
      { root: null, rootMargin: `0px 0px ${LOAD_MARGIN}px 0px` },
    )
    observer.observe(sentinel)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [loaded, items.length, width])

  const reachedEnd = loaded >= items.length && items.length > 0
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div data-testid="home-inspiration-feed" data-columns={columns} data-loaded={loaded}>
      <div ref={setNode} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((entry) => {
          const item = items[entry.index]
          if (!item) return null
          return (
            <div
              key={entry.key}
              data-index={entry.index}
              data-inspiration-id={item.id}
              ref={virtualizer.measureElement}
              className="absolute top-0"
              style={{
                left: entry.lane * (columnWidth + gap),
                width: columnWidth,
                transform: `translateY(${entry.start - scrollMargin}px)`,
              }}
            >
              <InspirationCard
                item={item}
                pinned={pinnedSet.has(item.id)}
                onClick={() => {
                  showDetail(item.id, item)
                  openInspiration()
                }}
                onMeasured={() => setRatioTick((tick) => tick + 1)}
              />
            </div>
          )
        })}
      </div>
      <div ref={sentinelRef} className="h-px" />
      {paging && !reachedEnd ? <InspirationPagingSkeleton columns={columns} /> : null}
      {reachedEnd ? (
        <div className="flex items-center justify-center gap-3 py-8 text-label-sm text-muted-foreground">
          <span className="h-px w-10 bg-border" />
          <span>{t('list.end', { count: items.length })}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => window.scrollTo({ top: 0 })}
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
