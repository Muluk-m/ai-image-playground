import { memo, useCallback, useMemo, useSyncExternalStore } from 'react'
import { VideoIcon } from '../../../components/icons'
import type { CanvasDoc, CanvasEl } from '../../canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../canvas/lib/editor'
import { ACTIVE_LIST_ROW, INK, INK_3 } from '../agentStyles'

const NAME_MAX_CHARS = 24

const TYPE_LABELS: Record<CanvasEl['type'], string> = {
  image: '图片',
  freedraw: '画笔',
  arrow: '箭头',
  text: '文字',
  placeholder: '生成中',
}

function shorten(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= NAME_MAX_CHARS) return trimmed
  return `${trimmed.slice(0, NAME_MAX_CHARS)}…`
}

/** 一行的主名：认得出是哪一个，而不是一列一模一样的类型名。 */
function displayName(element: CanvasEl): string {
  if (element.type === 'text') return shorten(element.text) || TYPE_LABELS.text
  if (element.type === 'image') return shorten(element.meta?.prompt ?? '') || TYPE_LABELS.image
  if (element.type === 'placeholder') return shorten(element.meta.prompt) || TYPE_LABELS.placeholder
  return TYPE_LABELS[element.type]
}

/** 副标题：这一行是什么东西。视频与静态图共用 image 类型，靠它区分。 */
function kindLabel(element: CanvasEl): string {
  if (element.type === 'image' && element.video) return '视频'
  if (element.type === 'placeholder') return element.message || TYPE_LABELS.placeholder
  return TYPE_LABELS[element.type]
}

const GLYPHS: Record<Exclude<CanvasEl['type'], 'image'>, string> = {
  text: 'T',
  freedraw: '✎',
  arrow: '↗',
  placeholder: '◌',
}

function Thumbnail({ element, src }: { element: CanvasEl; src?: string }) {
  if (element.type === 'image' && src) {
    return (
      <span className="relative h-8 w-8 shrink-0">
        <img src={src} alt="" className="h-8 w-8 rounded bg-black object-cover" />
        {element.video && (
          <VideoIcon
            aria-hidden="true"
            className="absolute right-0 bottom-0 h-3 w-3 rounded-br bg-black/70 text-white"
          />
        )}
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[11px] ${INK_3}`}
    >
      {element.type === 'image' ? '□' : GLYPHS[element.type]}
    </span>
  )
}

/**
 * 行单独 memo：`doc.emit()` 在平移、缩放、拖动元素时持续触发，父组件跟着重渲染，
 * 但绝大多数行的入参一个没变。不 memo 的话每帧都要把整张列表调和一遍。
 */
const LayerRow = memo(function LayerRow({
  element,
  src,
  selected,
  onSelect,
}: {
  element: CanvasEl
  src?: string
  selected: boolean
  onSelect: (id: string) => void
}) {
  const name = displayName(element)
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-label={`选中图层 ${name}`}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06] ${selected ? ACTIVE_LIST_ROW : ''}`}
        onClick={() => onSelect(element.id)}
      >
        <Thumbnail element={element} src={src} />
        <span className="flex min-w-0 flex-col">
          <span data-layer-name className={`truncate text-xs ${INK}`}>
            {name}
          </span>
          <span className={`truncate text-[11px] ${INK_3}`}>{kindLabel(element)}</span>
        </span>
      </button>
    </li>
  )
})

export default function AgentLayers({ doc, editor }: { doc: CanvasDoc; editor: CanvasEditor }) {
  const version = useSyncExternalStore(doc.subscribe, () => doc.version)
  // 最上层的元素排在最前。反转的是副本而不是 CSS：DOM 顺序要和看到的顺序一致，
  // 否则读屏和键盘 Tab 的次序跟视觉是反的。
  const rows = useMemo(() => [...doc.elements].reverse(), [doc, version])
  const { selection } = doc

  const onSelect = useCallback(
    (id: string) => {
      editor.setSelectedElements([id])
      editor.scrollToElements([id])
    },
    [editor],
  )

  if (rows.length === 0) {
    return <p className={`px-3 py-2 text-xs ${INK_3}`}>画布还是空的</p>
  }

  return (
    <ul className="flex flex-col gap-0.5 px-2">
      {rows.map((element) => (
        <LayerRow
          key={element.id}
          element={element}
          src={element.type === 'image' ? doc.files[element.fileId] : undefined}
          selected={selection.has(element.id)}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}
