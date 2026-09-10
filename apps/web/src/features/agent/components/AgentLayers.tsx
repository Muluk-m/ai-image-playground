import { useMemo, useSyncExternalStore } from 'react'
import type { CanvasDoc, CanvasEl } from '../../canvas/lib/canvasDoc'
import { INK, INK_3 } from '../agentStyles'

const LABELS: Record<CanvasEl['type'], string> = {
  image: '图片',
  freedraw: '画笔',
  arrow: '箭头',
  text: '文字',
  placeholder: '生成中',
}

function label(element: CanvasEl): string {
  if (element.type === 'text') return element.text.trim().slice(0, 20) || LABELS.text
  return LABELS[element.type]
}

export default function AgentLayers({ doc }: { doc: CanvasDoc }) {
  const version = useSyncExternalStore(doc.subscribe, () => doc.version)
  const elements = useMemo(() => doc.elements, [doc, version])

  if (elements.length === 0) {
    return <p className={`px-3 py-2 text-xs ${INK_3}`}>画布还是空的</p>
  }
  return (
    // 最上层的元素排在最前，所以倒着铺而不是复制一份反转数组。
    <ul className="flex flex-col-reverse justify-end gap-0.5 px-2">
      {elements.map((element) => (
        <li key={element.id} className={`truncate rounded-lg px-2 py-1.5 text-xs ${INK}`}>
          {label(element)}
        </li>
      ))}
    </ul>
  )
}
