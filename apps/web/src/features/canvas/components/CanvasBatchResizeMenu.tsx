import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { useTranslation } from '../../../i18n'
import type { ImageEl } from '../lib/canvasDoc'
import { RESIZE_RATIOS, submitCanvasResize } from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'

/** 与单图同一组比例；每张各出一版，原图保留。 */
export default function CanvasBatchResizeMenu({
  editor,
  images,
  x,
  y,
  onClose,
}: {
  editor: CanvasEditor
  images: readonly ImageEl[]
  x: number
  y: number
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      {RESIZE_RATIOS.map(({ ratio, key }) => (
        <ContextMenuItem
          key={ratio}
          icon={<span className="w-6 text-center text-xs tabular-nums">{ratio}</span>}
          label={t(`resize.ratio.${key}`)}
          onClick={() => {
            onClose()
            void (async () => {
              for (const image of images) {
                const current = editor.getElement(image.id)
                if (current?.type !== 'image' || current.video) continue
                if (!(await submitCanvasResize(editor, current, ratio))) break
              }
            })()
          }}
        />
      ))}
    </ContextMenu>
  )
}
