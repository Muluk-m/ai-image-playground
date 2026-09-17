import { useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import type { CanvasDoc } from '../lib/canvasDoc'
import { elementBounds } from '../lib/editor'
import { canvasImageDimensions, canvasImageName } from '../lib/imageInfo'
import type { CanvasImageMenuState } from './CanvasImageMenu'

export default function SelectionInfo({
  doc,
  onImageMenu,
}: {
  doc: CanvasDoc
  onImageMenu: (menu: CanvasImageMenuState) => void
}) {
  const { t } = useTranslation('canvas')
  useSyncExternalStore(doc.subscribe, () => doc.version)
  if (doc.selection.size !== 1) return null
  const element = doc.getElement([...doc.selection][0]!)
  if (element?.type !== 'image' && element?.type !== 'text') return null
  const bounds = elementBounds(element)
  const { camera } = doc
  const left = (bounds.x - camera.x) * camera.zoom
  const imageTop = (bounds.y - camera.y) * camera.zoom
  const imageBottom = imageTop + bounds.h * camera.zoom
  const labelWidth = Math.min(240, Math.max(120, bounds.w * camera.zoom), doc.viewport.width - 16)
  const width = bounds.w * camera.zoom
  const dimensions = element.type === 'image' ? canvasImageDimensions(element, doc) : null
  if (
    left + width < 0 ||
    left > doc.viewport.width ||
    imageTop > doc.viewport.height ||
    imageBottom < 0
  )
    return null
  const name = element.type === 'image' ? canvasImageName(element) : element.text
  return (
    <div
      data-selection-info
      className="pointer-events-none absolute z-10 flex items-center gap-2 rounded-md border border-border bg-card/95 px-2 py-1 text-[11px] font-medium shadow-sm"
      style={{
        left: Math.max(8, Math.min(left, doc.viewport.width - labelWidth - 8)),
        top: Math.max(8, Math.min(imageBottom + 10, doc.viewport.height - 72)),
        width: labelWidth,
      }}
    >
      <span className="min-w-0 flex-1 truncate text-foreground" title={name}>
        {name}
      </span>
      {dimensions && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {dimensions.width} × {dimensions.height}
        </span>
      )}
      <button
        type="button"
        className="pointer-events-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-primary hover:bg-muted"
        aria-label={element.type === 'text' ? t('touch.editText') : t('touch.imageActions')}
        onClick={(event) => {
          if (element.type === 'text') doc.setEditingText(element.id)
          else {
            const rect = event.currentTarget.getBoundingClientRect()
            onImageMenu({ id: element.id, x: rect.left, y: rect.bottom })
          }
        }}
      >
        {element.type === 'text' ? t('touch.edit') : '⋯'}
      </button>
    </div>
  )
}
