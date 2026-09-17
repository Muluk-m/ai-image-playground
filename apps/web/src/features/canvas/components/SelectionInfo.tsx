import { useSyncExternalStore } from 'react'
import type { CanvasDoc } from '../lib/canvasDoc'
import { elementBounds } from '../lib/editor'
import { canvasImageDimensions, canvasImageName } from '../lib/imageInfo'

export default function SelectionInfo({ doc }: { doc: CanvasDoc }) {
  useSyncExternalStore(doc.subscribe, () => doc.version)
  if (doc.selection.size !== 1) return null
  const element = doc.getElement([...doc.selection][0]!)
  if (element?.type !== 'image') return null
  const bounds = elementBounds(element)
  const { camera } = doc
  const left = (bounds.x - camera.x) * camera.zoom
  const imageTop = (bounds.y - camera.y) * camera.zoom
  const imageBottom = imageTop + bounds.h * camera.zoom
  const labelWidth = Math.min(240, Math.max(120, bounds.w * camera.zoom), doc.viewport.width - 16)
  const width = bounds.w * camera.zoom
  const dimensions = canvasImageDimensions(element, doc)
  if (
    left + width < 0 ||
    left > doc.viewport.width ||
    imageTop > doc.viewport.height ||
    imageBottom < 0
  )
    return null
  return (
    <div
      data-selection-info
      className="pointer-events-none absolute z-10 flex items-center gap-2 rounded-md border border-border bg-card/95 px-2 py-1 text-[11px] font-medium shadow-sm"
      style={{
        left: Math.max(8, Math.min(left, doc.viewport.width - labelWidth - 8)),
        top: Math.max(8, Math.min(imageBottom + 10, doc.viewport.height - 36)),
        width: labelWidth,
      }}
    >
      <span className="min-w-0 flex-1 truncate text-foreground" title={canvasImageName(element)}>
        {canvasImageName(element)}
      </span>
      {dimensions && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {dimensions.width} × {dimensions.height}
        </span>
      )}
    </div>
  )
}
