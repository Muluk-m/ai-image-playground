import { memo, useCallback, useMemo, useSyncExternalStore } from 'react'
import { VideoIcon } from '../../../components/icons'
import { currentLocale, i18next, useTranslation } from '../../../i18n'
import type { CanvasDoc, CanvasEl, ImageEl, PlaceholderEl } from '../../canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../canvas/lib/editor'
import { canvasElementCreatedAt, canvasImageName } from '../../canvas/lib/imageInfo'

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

const WorkCard = memo(function WorkCard({
  element,
  src,
  selected,
  onSelect,
}: {
  element: Work
  src?: string
  selected: boolean
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation('agent')
  const name =
    element.type === 'image'
      ? canvasImageName(element)
      : element.meta.prompt || t('creations.taskTitle')
  const loading = element.type === 'placeholder' && element.status === 'loading'
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
  editor,
  onSelect: onSelectWork,
}: {
  doc: CanvasDoc
  editor: CanvasEditor
  onSelect?: () => void
}) {
  const { t, i18n } = useTranslation('agent')
  useSyncExternalStore(doc.subscribe, () => doc.version)
  // 分组标题里的兜底文案是界面文案，切语言要跟着换，所以语言也是这份缓存的入参。
  const groups = useMemo(() => groupsFor(doc.elements), [doc.elements, i18n.language])
  const marks = doc.elements.filter(
    (element) => element.type !== 'image' && element.type !== 'placeholder',
  )
  const onSelect = useCallback(
    (id: string) => {
      onSelectWork?.()
      editor.setSelectedElements([id])
      editor.scrollToElements([id])
    },
    [editor, onSelectWork],
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
                src={element.type === 'image' ? doc.files[element.fileId] : undefined}
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
