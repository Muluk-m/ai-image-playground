import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { VideoIcon } from '../../../components/icons'
import { currentLocale, i18next, useTranslation } from '../../../i18n'
import type { CanvasDoc, CanvasEl, ImageEl, PlaceholderEl } from '../../canvas/lib/canvasDoc'
import { canvasElementCreatedAt, canvasImageName } from '../../canvas/lib/imageInfo'
import { type AgentCanvasSink, agentCanvasSink, onAgentCanvasSinkChange } from '../lib/canvasSink'
import AgentCreationsGallery from './AgentCreationsGallery'

type Work = ImageEl | PlaceholderEl
interface CreationGroup {
  id: string
  title: string
  createdAt: number
  items: Work[]
}

function groupsFor(elements: readonly CanvasEl[]): CreationGroup[] {
  const groups = new Map<string, CreationGroup>()
  for (const element of [...elements].reverse()) {
    if (element.type !== 'image' && element.type !== 'placeholder') continue
    const createdAt = canvasElementCreatedAt(element)
    const explicit =
      element.type === 'image'
        ? element.groupId
        : element.meta.taskId || element.meta.clientRequestId
    const id = explicit || (createdAt ? `date:${new Date(createdAt).toDateString()}` : 'earlier')
    let group = groups.get(id)
    if (!group) {
      const prompt = element.type === 'image' ? element.meta?.prompt : element.meta.prompt
      group = {
        id,
        title:
          prompt ||
          (element.type === 'placeholder'
            ? i18next.t('creations.taskTitle', { ns: 'agent' })
            : explicit
              ? i18next.t('creations.importedTitle', { ns: 'agent' })
              : i18next.t('creations.earlierTitle', { ns: 'agent' })),
        createdAt,
        items: [],
      }
      groups.set(id, group)
    }
    group.createdAt = Math.max(group.createdAt, createdAt)
    group.items.push(element)
  }
  return [...groups.values()].sort((a, b) => b.createdAt - a.createdAt)
}

const NO_THUMBNAILS: ReadonlyMap<string, string | null> = new Map()

/** 位图身份。`doc.version` 每帧都可能变，只有对象换了图才该重取缩略图。 */
function bitmapKey(element: ImageEl): string {
  return `${element.id}:${element.fileId}`
}

/**
 * 作品的缩略图走画布出口：栅格化、视频封面恢复和按 `objectId:fileId` 的缓存都在 sink 里。
 * 值是 `string` 表示取到了，`null` 表示取不到（对象已删、位图缺失），键不在表示还在取。
 * 出口不在时退回文档里的全尺寸位图——骨架屏等不到画布挂上来。
 */
function useCanvasThumbnails(
  doc: CanvasDoc,
  works: readonly ImageEl[],
): ReadonlyMap<string, string | null> {
  const sink = useSyncExternalStore(onAgentCanvasSinkChange, agentCanvasSink)
  const cache = useRef<ReadonlyMap<string, string | null>>(NO_THUMBNAILS)
  const cacheSink = useRef<AgentCanvasSink | null>(sink)
  const [thumbnails, setThumbnails] = useState(cache.current)
  const signature = works.map(bitmapKey).join(' ')
  const files = doc.files
  const fallback = useMemo(
    () => new Map(works.map((work) => [bitmapKey(work), files[work.fileId] ?? null])),
    [files, signature],
  )

  useEffect(() => {
    // 画布换了（切项目、画布卸载）：上一块画布的位图作废。
    if (cacheSink.current !== sink) {
      cacheSink.current = sink
      cache.current = NO_THUMBNAILS
      setThumbnails(NO_THUMBNAILS)
    }
    // 删掉的作品不留在缓存里：同一个 id 配同一张位图再出现时要重新问一次画布。
    const live = new Set(works.map(bitmapKey))
    const kept = new Map([...cache.current].filter(([key]) => live.has(key)))
    if (kept.size !== cache.current.size) {
      cache.current = kept
      setThumbnails(kept)
    }
    if (!sink) return
    let alive = true
    void (async () => {
      // 一屏可能有几十件作品，栅格化不便宜：按列表顺序逐件取，不一次并发几十张占死主线程。
      // sink 自己按位图身份缓存，所以反复折叠面板 / 切页签只有新作品要真取。
      for (const work of works) {
        const key = bitmapKey(work)
        if (cache.current.has(key)) continue
        const thumbnail = await sink.thumbnail(work.id)
        // 迟到的图既不能落到已卸载的组件上，也不能落到换掉的画布上。
        if (!alive || agentCanvasSink() !== sink) return
        const next = new Map(cache.current).set(key, thumbnail)
        cache.current = next
        setThumbnails(next)
      }
    })()
    return () => {
      alive = false
    }
    // works 每次渲染都是新数组，用位图身份合成的 signature 当依赖。
  }, [sink, signature])

  return sink ? thumbnails : fallback
}

/**
 * 定位交给画布出口。出口还没注册（画布正在挂载 / 移动端刚切过去）时记下这一件，
 * 等它注册再补上——否则用户到了画布，那件作品却没被选中。
 */
function useLocateOnCanvas(): (objectId: string) => void {
  const pending = useRef<string | null>(null)
  useEffect(
    () =>
      onAgentCanvasSinkChange((sink) => {
        const objectId = pending.current
        if (!sink || !objectId) return
        pending.current = null
        sink.focus([objectId])
      }),
    [],
  )
  return useCallback((objectId: string) => {
    const sink = agentCanvasSink()
    if (sink) sink.focus([objectId])
    else pending.current = objectId
  }, [])
}

const WorkCard = memo(function WorkCard({
  element,
  src,
  selected,
  onSelect,
}: {
  element: Work
  /** `undefined` 表示缩略图还在取，`null` 表示取不到。 */
  src?: string | null
  selected: boolean
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation('agent')
  const name =
    element.type === 'image'
      ? canvasImageName(element)
      : element.meta.prompt || t('creations.taskTitle')
  const loading = element.type === 'placeholder' && element.status === 'loading'
  const pending = element.type === 'image' && src === undefined
  return (
    <button
      type="button"
      aria-label={t('creations.locateAria', { name })}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(element.id)}
      className={`group mb-3 block w-full break-inside-avoid overflow-hidden rounded-xl border text-left transition ${selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/60'} bg-card`}
    >
      {element.type === 'image' && src ? (
        <div className="relative">
          <img src={src} alt="" loading="lazy" className="block h-auto w-full" />
          {element.video && (
            <VideoIcon
              className="absolute bottom-2 right-2 h-5 w-5 rounded bg-black/60 p-0.5 text-white"
              aria-hidden="true"
            />
          )}
        </div>
      ) : pending ? (
        // 取图期间先占住位：用画布上的比例画一块骨架，图到了不会把整列推一下。
        <div
          style={{ aspectRatio: `${element.width} / ${element.height}` }}
          className="min-h-24 animate-pulse bg-muted"
          aria-hidden="true"
        />
      ) : (
        <div
          style={{ aspectRatio: `${element.width} / ${element.height}` }}
          className="flex min-h-24 flex-col items-center justify-center gap-2 bg-muted px-3 text-xs text-muted-foreground"
        >
          <span className={loading ? 'animate-pulse text-xl' : 'text-xl'} aria-hidden="true">
            {loading ? '✧' : '!'}
          </span>
          <span>
            {loading
              ? t('creations.generating')
              : element.type === 'placeholder'
                ? element.message || t('creations.notFinished')
                : t('creations.previewUnavailable')}
          </span>
        </div>
      )}
      <span className="block truncate px-2.5 pb-1 pt-2 text-[11px] text-foreground" title={name}>
        {name}
      </span>
      {element.type === 'image' && element.naturalWidth && element.naturalHeight && (
        <span className="block px-2.5 pb-2 text-[10px] text-muted-foreground tabular-nums">
          {element.naturalWidth} × {element.naturalHeight}
        </span>
      )}
    </button>
  )
})

export default function AgentCreations({
  doc,
  onSelect: onSelectWork,
}: {
  doc: CanvasDoc
  onSelect?: () => void
}) {
  const { t, i18n } = useTranslation('agent')
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const [gallery, setGallery] = useState(false)
  // 分组标题里的兜底文案是界面文案，切语言要跟着换，所以语言也是这份缓存的入参。
  const groups = useMemo(() => groupsFor(doc.elements), [doc.elements, i18n.language])
  const works = useMemo(
    () =>
      groups
        .flatMap((group) => group.items)
        .filter((element): element is ImageEl => element.type === 'image'),
    [groups],
  )
  const thumbnails = useCanvasThumbnails(doc, works)
  // 时间线是编排工具，不是画在画布上的标注。
  const marks = doc.elements.filter(
    (element) =>
      element.type !== 'image' && element.type !== 'placeholder' && element.type !== 'timeline',
  )
  const locate = useLocateOnCanvas()
  const onSelect = useCallback(
    (id: string) => {
      onSelectWork?.()
      // 定位与结果卡同一条出口：不在画布上的对象由 sink 过滤掉。
      locate(id)
    },
    [onSelectWork, locate],
  )
  if (!groups.length && !marks.length)
    return (
      <div className="px-5 py-10 text-center text-xs leading-relaxed text-muted-foreground">
        {t('creations.emptyTitle')}
        <br />
        {t('creations.emptyBody')}
      </div>
    )
  return (
    <div className="space-y-6 px-3 py-3">
      {works.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {t('creations.itemCount', { count: works.length })}
          </span>
          <button
            type="button"
            onClick={() => setGallery(true)}
            className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:border-primary/60 hover:bg-muted"
          >
            {t('creations.viewAll')}
          </button>
        </div>
      )}
      {gallery && (
        <AgentCreationsGallery
          doc={doc}
          works={works}
          srcOf={(element) => thumbnails.get(bitmapKey(element))}
          onClose={() => setGallery(false)}
        />
      )}
      {groups.map((group) => (
        <section key={group.id} aria-label={group.title}>
          <div className="mb-2.5 flex items-start justify-between gap-2">
            <h3 className="line-clamp-2 text-xs font-medium text-foreground" title={group.title}>
              {group.title}
            </h3>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t('creations.itemCount', { count: group.items.length })}
            </span>
          </div>
          {group.createdAt > 0 && (
            <p className="mb-2 text-[10px] text-muted-foreground">
              {new Intl.DateTimeFormat(currentLocale(), {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(group.createdAt))}
            </p>
          )}
          <div className="columns-2 gap-2.5">
            {group.items.map((element) => (
              <WorkCard
                key={element.id}
                element={element}
                src={element.type === 'image' ? thumbnails.get(bitmapKey(element)) : null}
                selected={doc.selection.has(element.id)}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      ))}
      {marks.length > 0 && (
        <details className="border-t border-border pt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {t('creations.marks')} · {marks.length}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {marks.map((element) => (
              <button
                key={element.id}
                type="button"
                onClick={() => onSelect(element.id)}
                className="max-w-full truncate rounded-md bg-muted px-2 py-1.5"
                aria-current={doc.selection.has(element.id) ? 'true' : undefined}
              >
                {element.type === 'text'
                  ? element.text || t('creations.markText')
                  : element.type === 'arrow'
                    ? t('creations.markArrow')
                    : t('creations.markPen')}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
