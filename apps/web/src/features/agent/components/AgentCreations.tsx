import { memo, useCallback, useMemo, useSyncExternalStore } from 'react'
import { VideoIcon } from '../../../components/icons'
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
          (element.type === 'placeholder' ? '生成任务' : explicit ? '导入图片' : '较早的内容'),
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
  const name =
    element.type === 'image' ? canvasImageName(element) : element.meta.prompt || '生成任务'
  const loading = element.type === 'placeholder' && element.status === 'loading'
  return (
    <button
      type="button"
      aria-label={`定位 ${name}`}
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
              ? '正在生成'
              : element.type === 'placeholder'
                ? element.message || '生成未完成'
                : '预览不可用'}
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
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const groups = useMemo(() => groupsFor(doc.elements), [doc.elements])
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
        还没有创作记录
        <br />
        生成作品或导入图片后，会按任务显示在这里。
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
              {group.items.length} 项
            </span>
          </div>
          {group.createdAt > 0 && (
            <p className="mb-2 text-[10px] text-muted-foreground">
              {new Date(group.createdAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
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
          <summary className="cursor-pointer">画布标注 · {marks.length}</summary>
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
                  ? element.text || '文字'
                  : element.type === 'arrow'
                    ? '箭头'
                    : '画笔'}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
