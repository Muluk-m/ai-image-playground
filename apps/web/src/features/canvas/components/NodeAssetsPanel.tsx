import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import SearchField from '../../../components/patterns/SearchField'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { type AssetDay, type CanvasAssetItem, groupAssetsByDay } from '../lib/canvasAssets'
import { type CanvasAssetScope, useCanvasAssets } from '../lib/useCanvasAssets'

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

export default function NodeAssetsPanel({
  conversationId,
  canvasItems,
  style,
  onClose,
  onPlace,
  onDownload,
}: {
  /** 当前项目绑定的对话；还没聊过时为 null，当前项目就是空的。 */
  conversationId: string | null
  /** 本画布节点跑出的结果，算在当前项目里。 */
  canvasItems?: readonly CanvasAssetItem[]
  style?: CSSProperties
  onClose: () => void
  /** 放上画布并选中；返回是否成功，失败时保留勾选。 */
  onPlace: (items: readonly CanvasAssetItem[]) => Promise<boolean>
  onDownload: (items: readonly CanvasAssetItem[]) => void
}) {
  const { t } = useTranslation('canvas')
  const [query, setQuery] = useState('')
  const [list, setList] = useState(false)
  const [wide, setWide] = useState(false)
  const [media, setMedia] = useState<Media>('image')
  const [scope, setScope] = useState<CanvasAssetScope>('project')
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

  const toggleSelecting = () => {
    setSelecting((on) => !on)
    setPicked([])
  }
  const choose = (item: CanvasAssetItem) => {
    if (!selecting) {
      void onPlace([item])
      return
    }
    setPicked((current) =>
      current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
    )
  }
  const apply = async () => {
    if (!pickedItems.length) return
    if (!(await onPlace(pickedItems))) return
    setPicked([])
    setSelecting(false)
  }
  const tab = (value: string, label: string, selected: boolean, onSelect: () => void) => (
    <Button
      key={value}
      type="button"
      variant="ghost"
      role="tab"
      aria-selected={selected}
      className="studio-assets-tab"
      onClick={onSelect}
    >
      {label}
    </Button>
  )

  return (
    <aside
      className="studio-assets-panel"
      data-wide={wide || undefined}
      style={style}
      aria-label={t('assetsPanel.title')}
    >
      <div className="studio-assets-head">
        <SearchField
          className="studio-assets-search"
          value={query}
          placeholder={t('assetsPanel.search')}
          aria-label={t('assetsPanel.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="studio-assets-iconbtn"
          aria-label={list ? t('assetsPanel.gridView') : t('assetsPanel.listView')}
          aria-pressed={list}
          onClick={() => setList((on) => !on)}
        >
          <Icon name={list ? 'grid' : 'list'} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="studio-assets-iconbtn"
          aria-label={t('assetsPanel.close')}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </div>
      <div className="studio-assets-tabs">
        <div role="tablist" className="studio-assets-tablist">
          {tab('image', t('assetsPanel.images', { count: counts.image }), media === 'image', () =>
            setMedia('image'),
          )}
          {tab('video', t('assetsPanel.videos', { count: counts.video }), media === 'video', () =>
            setMedia('video'),
          )}
        </div>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="studio-assets-textbtn"
          aria-pressed={selecting}
          onClick={toggleSelecting}
        >
          {selecting ? t('assetsPanel.cancel') : t('assetsPanel.select')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="studio-assets-iconbtn"
          aria-label={wide ? t('assetsPanel.collapse') : t('assetsPanel.expand')}
          aria-pressed={wide}
          onClick={() => setWide((on) => !on)}
        >
          <Icon name={wide ? 'minimize' : 'fullscreen'} size="sm" />
        </Button>
      </div>
      {wide && (
        <div role="tablist" className="studio-assets-tabs studio-assets-scope">
          {tab('all', t('assetsPanel.scopeAll'), scope === 'all', () => setScope('all'))}
          {tab('project', t('assetsPanel.scopeProject'), scope === 'project', () =>
            setScope('project'),
          )}
        </div>
      )}
      <div
        ref={gridRef}
        className="studio-assets-grid"
        data-list={list || undefined}
        data-selecting={selecting || undefined}
      >
        {groups.map((group) => (
          <div key={group.key} className="contents">
            <p className="studio-assets-day">{dayLabel(group.day)}</p>
            {group.items.map((item) => {
              const on = picked.includes(item.id)
              const common = {
                type: 'button' as const,
                variant: 'ghost' as const,
                title: item.title,
                'aria-label': item.title,
                'data-selected': on || undefined,
                ...(selecting ? { role: 'checkbox', 'aria-checked': on } : {}),
                onClick: () => choose(item),
              }
              return list ? (
                <Button key={item.id} {...common} className="studio-assets-row">
                  <AssetThumb item={item} className="studio-assets-row-thumb" />
                  <span className="studio-assets-format">{item.format}</span>
                </Button>
              ) : (
                <Button key={item.id} {...common} className="studio-assets-card">
                  <AssetThumb item={item} className="studio-assets-card-thumb" />
                  <span className="studio-assets-pill">
                    {item.media === 'video' ? t('assetsPanel.tagVideo') : t('assetsPanel.tagImage')}
                  </span>
                  {selecting && (
                    <span className="studio-assets-check" aria-hidden>
                      {on && <Icon name="check" size="xs" />}
                    </span>
                  )}
                </Button>
              )
            })}
          </div>
        ))}
        {!shown.length && !loading && (
          <p className="studio-assets-day">
            {failed ? t('assetsPanel.loadFailed') : t('assetsPanel.empty')}
          </p>
        )}
        {hasMore && <div ref={endRef} className="studio-assets-end" aria-hidden />}
      </div>
      {selecting && (
        <div className="studio-assets-bar">
          <span className="studio-assets-count">
            {t('assetsPanel.selected', { count: pickedItems.length })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="studio-assets-barbtn"
            disabled={!pickedItems.length}
            onClick={() => onDownload(pickedItems)}
          >
            {t('assetsPanel.download')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="studio-assets-barbtn studio-assets-apply"
            disabled={!pickedItems.length}
            onClick={() => void apply()}
          >
            {t('assetsPanel.apply')}
          </Button>
        </div>
      )}
    </aside>
  )
}
