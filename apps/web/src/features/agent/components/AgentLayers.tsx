import { useSyncExternalStore } from 'react'
import type { CanvasDoc, CanvasEl } from '../../canvas/lib/canvasDoc'
import { INK, INK_3 } from '../agentStyles'

const LABELS: Record<CanvasEl['type'], string> = {
  image: '图片',
  freedraw: '画笔',
  arrow: '箭头',
  text: '文字',
  placeholder: '生成中',
}

function name(element: CanvasEl): string {
  if (element.type === 'text') return element.text.trim().slice(0, 20) || LABELS.text
  return LABELS[element.type]
}

export default function AgentLayers({ doc }: { doc: CanvasDoc }) {
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const elements = [...doc.elements].reverse()

  if (elements.length === 0) {
    return <p className={`px-3 py-2 text-xs ${INK_3}`}>画布还是空的</p>
  }
  return (
    <ul className="flex flex-col gap-0.5 px-2">
      {elements.map((element) => (
        <li
          key={element.id}
          className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs ${INK}`}
        >
          <span className="truncate">{name(element)}</span>
          <span className={`shrink-0 text-[10px] ${INK_3}`}>{LABELS[element.type]}</span>
        </li>
      ))}
    </ul>
  )
}
