import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import SearchField from '../../../components/patterns/SearchField'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useCanvasAssetsEntry } from '../lib/assetsEntry'
import { type AssetDay, type CanvasAssetItem, groupAssetsByDay } from '../lib/canvasAssets'
import { useCanvasAssets } from '../lib/useCanvasAssets'
import MediaTransferCard from './MediaTransferCard'

type Media = CanvasAssetItem['media']

/** 缩略图进入可视区才去取，几百件作品时不一次把预览全拉下来。 */
function AssetThumb({ item, className }: { item: CanvasAssetItem; className: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const load = () => {
      item.load().then(
        (next) => {
          if (!cancelled) setSrc(next)
        },
        () => {},
      )
    }
    if (typeof IntersectionObserver === 'undefined') {
      load()
      return () => {
        cancelled = true
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        load()
      },
      { rootMargin: '220px' },
    )
    observer.observe(el)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [item])
  return (
    <span ref={ref} className={className}>
      {src && <img src={src} alt="" draggable={false} />}
    </span>
  )
}

/**
 * 画布「资产」整屏弹窗：四边留 24px，带遮罩。顶上一行是标题、图片/视频页签、搜索、选择与关闭，
 * 下一行是所有项目/当前项目。点一件或「应用到画布」就在画面中间放上节点并关掉弹窗；
 * 「下载」打包 ZIP，弹窗不关。关掉时清空勾选、退出选择，页签和项目范围留到下次。
 */
export default function NodeAssetsPanel({
  conversationId,
  canvasItems,
  onClose,
  onPlace,
  onDownload,
}: {
  /** 当前项目绑定的对话；还没聊过时为 null，当前项目就只有画布节点的结果。 */
  conversationId: string | null
  /** 本画布节点跑出的结果，算在当前项目里。 */
  canvasItems?: readonly CanvasAssetItem[]
  onClose: () => void
  /** 放上画布并选中；返回是否成功，失败时弹窗不关、保留勾选。 */
  onPlace: (items: readonly CanvasAssetItem[]) => Promise<boolean>
  onDownload: (items: readonly CanvasAssetItem[]) => void
}) {
  const { t } = useTranslation('canvas')
  const titleId = useId()
  const media = useCanvasAssetsEntry((s) => s.media)
  const setMedia = useCanvasAssetsEntry((s) => s.setMedia)
  const scope = useCanvasAssetsEntry((s) => s.scope)
  const setScope = useCanvasAssetsEntry((s) => s.setScope)
  const [query, setQuery] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<readonly string[]>([])
  const assets = useCanvasAssets(conversationId, scope, canvasItems)
  const counts = useMemo(() => {
    const next = { image: 0, video: 0 }
    for (const item of assets.items) next[item.media] += 1
    return next
  }, [assets.items])
  const needle = query.trim().toLocaleLowerCase()
  const shown = useMemo(
    () =>
      assets.items.filter(
        (item) =>
          item.media === media && (!needle || item.title.toLocaleLowerCase().includes(needle)),
      ),
    [assets.items, media, needle],
  )
  const groups = useMemo(() => groupAssetsByDay(shown), [shown])
  const pickedItems = useMemo(() => {
    const byId = new Map(assets.items.map((item) => [item.id, item]))
    return picked.flatMap((id) => byId.get(id) ?? [])
  }, [assets.items, picked])
  const dayLabel = (day: AssetDay) =>
    day.kind === 'today'
      ? t('assetsPanel.today')
      : day.kind === 'yesterday'
        ? t('assetsPanel.yesterday')
        : t('assetsPanel.date', { month: day.month, day: day.day })

  // 打开就把焦点放进搜索框；子组件的 effect 先于 Overlay 的焦点陷阱，陷阱看到焦点已在里面就不再改。
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true })
  }, [])

  const gridRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const { hasMore, loading, failed, loadMore } = assets
  useEffect(() => {
    const end = endRef.current
    if (!hasMore || loading || failed || !end || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore()
      },
      { root: gridRef.current, rootMargin: '220px' },
    )
    observer.observe(end)
    return () => observer.disconnect()
  }, [hasMore, loading, failed, loadMore])

  // 放置要先取像素，期间再点不重复建节点；失败（含抛错）时保留已选、弹窗不关，提示由 onPlace 给。
  const placing = useRef(false)
  const [busy, setBusy] = useState(false)
  const place = async (items: readonly CanvasAssetItem[]) => {
    if (!items.length || placing.current) return
    placing.current = true
    setBusy(true)
    let placed = false
    try {
      placed = await onPlace(items)
    } catch {
      placed = false
    } finally {
      placing.current = false
      setBusy(false)
    }
    if (placed) onClose()
  }
  const switchScope = (next: 'all' | 'project') => {
    setScope(next)
    setPicked([])
  }
  const toggleSelecting = () => {
    setSelecting((on) => !on)
    setPicked([])
  }
  const choose = (item: CanvasAssetItem) => {
    if (!selecting) {
      void place([item])
      return
    }
    setPicked((current) =>
      current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
    )
  }
  const switchMedia = (next: Media) => {
    if (next === media) return
    setMedia(next)
    setPicked([])
  }
  const tab = (
    value: string,
    label: string,
    selected: boolean,
    onSelect: () => void,
    className: string,
  ) => (
    <Button
      key={value}
      type="button"
      variant="ghost"
      role="tab"
      aria-selected={selected}
      className={className}
      onClick={onSelect}
    >
      {label}
    </Button>
  )

  return (
    <Overlay onClose={onClose} tier="assets" layout="fill" role="none">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="studio-canvas-assets-modal"
      >
        <div className="studio-canvas-assets-head">
          <h2 id={titleId} className="studio-canvas-assets-title">
            {t('assetsPanel.title')}
          </h2>
          <div role="tablist" className="studio-canvas-assets-tablist">
            {tab(
              'image',
              t('assetsPanel.images', { count: counts.image }),
              media === 'image',
              () => switchMedia('image'),
              'studio-canvas-assets-tab',
            )}
            {tab(
              'video',
              t('assetsPanel.videos', { count: counts.video }),
              media === 'video',
              () => switchMedia('video'),
              'studio-canvas-assets-tab',
            )}
          </div>
          <span className="flex-1" />
          <SearchField
            ref={searchRef}
            className="studio-canvas-assets-search"
            value={query}
            placeholder={t('assetsPanel.search')}
            aria-label={t('assetsPanel.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="studio-canvas-assets-select"
            aria-pressed={selecting}
            onClick={toggleSelecting}
          >
            {selecting ? t('assetsPanel.cancel') : t('assetsPanel.select')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="studio-canvas-assets-iconbtn"
            aria-label={t('assetsPanel.close')}
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </div>
        <div role="tablist" className="studio-canvas-assets-scope">
          {tab(
            'all',
            t('assetsPanel.scopeAll'),
            scope === 'all',
            () => switchScope('all'),
            'studio-canvas-assets-chip',
          )}
          {tab(
            'project',
            t('assetsPanel.scopeProject'),
            scope === 'project',
            () => switchScope('project'),
            'studio-canvas-assets-chip',
          )}
        </div>
        <div
          ref={gridRef}
          className="studio-canvas-assets-grid"
          data-selecting={selecting || undefined}
        >
          {groups.map((group) => (
            <div key={group.key} className="contents">
              <p className="studio-canvas-assets-day">{dayLabel(group.day)}</p>
              {group.items.map((item) => {
                const on = picked.includes(item.id)
                return (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    title={item.title}
                    aria-label={item.title}
                    data-selected={on || undefined}
                    {...(selecting ? { role: 'checkbox', 'aria-checked': on } : {})}
                    className="studio-canvas-assets-card"
                    onClick={() => choose(item)}
                  >
                    <AssetThumb item={item} className="studio-canvas-assets-card-thumb" />
                    <span className="studio-canvas-assets-pill">
                      {item.media === 'video'
                        ? t('assetsPanel.tagVideo')
                        : t('assetsPanel.tagImage')}
                    </span>
                    {selecting && (
                      <span className="studio-canvas-assets-check" aria-hidden>
                        {on && <Icon name="check" size="xs" />}
                      </span>
                    )}
                  </Button>
                )
              })}
            </div>
          ))}
          {!shown.length && !loading && (
            <p className="studio-canvas-assets-day">
              {failed ? t('assetsPanel.loadFailed') : t('assetsPanel.empty')}
            </p>
          )}
          {hasMore && <div ref={endRef} className="studio-canvas-assets-end" aria-hidden />}
        </div>
        {selecting && (
          <div className="studio-canvas-assets-bar">
            <span className="studio-canvas-assets-count">
              {t('assetsPanel.selected', { count: pickedItems.length })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="studio-canvas-assets-barbtn"
              disabled={!pickedItems.length}
              onClick={() => onDownload(pickedItems)}
            >
              <Icon name="download" />
              {t('assetsPanel.download')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="studio-canvas-assets-barbtn studio-canvas-assets-apply"
              disabled={!pickedItems.length || busy}
              onClick={() => void place(pickedItems)}
            >
              {t('assetsPanel.apply')}
            </Button>
          </div>
        )}
      </div>
      {/* 下载时弹窗不关：传输卡跟进弹窗这一层，抬到底部操作条上方。 */}
      <MediaTransferCard lifted />
    </Overlay>
  )
}
