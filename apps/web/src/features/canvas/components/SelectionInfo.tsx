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
  const top = (bounds.y - camera.y) * camera.zoom - 28
  const width = bounds.w * camera.zoom
  const dimensions = canvasImageDimensions(element, doc)
  if (left + width < 0 || left > doc.viewport.width || top > doc.viewport.height || top < -28)
    return null
  return (
    <div
      data-selection-info
      className="pointer-events-none absolute z-10 flex items-center justify-between gap-3 text-xs font-medium"
      style={{ left, top: Math.max(2, top), width: Math.max(160, width) }}
    >
      <span className="truncate text-sky-500" title={canvasImageName(element)}>
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
