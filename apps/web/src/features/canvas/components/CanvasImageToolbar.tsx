import {
  Brush,
  Copy,
  Crop,
  Download,
  Eraser,
  Expand,
  MoreHorizontal,
  RotateCcw,
} from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { useInpaintSession } from '../inpaintStore'
import { canvasImageSource, copyCanvasImage, downloadCanvasImage } from '../lib/canvasImageActions'
import { outpaintRefusal, regenerateCanvasImage, regenerateRefusal } from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'
import { canvasImageDimensions } from '../lib/imageInfo'
import { inpaintRefusal } from '../lib/submitInpaint'
import { useRectEdit } from '../rectEditStore'
import CanvasImageMenu, { type CanvasImageMenuState } from './CanvasImageMenu'
import CanvasToolbarButton from './CanvasToolbarButton'

/** 工具条与图片之间的留白，以及它自己的高度（贴到视口底时据此翻到上沿）。 */
const TOOLBAR_GAP = 10
const TOOLBAR_HEIGHT = 40

/**
 * 单选一张图片时浮在它**下方**的操作条：常用动作直出，其余收进「更多」。
 *
 * 放下沿是照产品形态走的（尺寸标签在上、动作条在下，见 `SelectionInfo`），
 * 也正好与 `CanvasVideoToolbar` 的上沿错开。「更多」直接复用右键那份
 * `CanvasImageMenu`——同一组动作两个入口，实现只有一份。
 */
export default function CanvasImageToolbar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation(['canvas', 'common'])
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const settings = useStore((state) => state.settings)
  const inpaintImageId = useInpaintSession((state) => state.imageId)
  const openInpaint = useInpaintSession((state) => state.open)
  const rectMode = useRectEdit((state) => state.mode)
  const openRect = useRectEdit((state) => state.open)
  const [menu, setMenu] = useState<CanvasImageMenuState | null>(null)

  const doc = editor.doc
  // 涂抹进行时让位给面板：这条工具条的动作这会儿都不该被点到。
  if (inpaintImageId || rectMode) return null
  if (doc.tool !== 'select' || doc.selection.size !== 1) return null
  const element = doc.getElement([...doc.selection][0] ?? '')
  // 画布上的视频也是 image 元素（位图当封面），它归 CanvasVideoToolbar 管。
  if (element?.type !== 'image' || element.video) return null
  // 这张图正在被重绘：卡片上盖着「局部重绘中」，别在遮罩上再浮一条能点的工具条。
  if (editor.getPlaceholders().some((one) => one.meta.editSourceId === element.id)) return null

  const bounds = editor.getElementPageBounds(element.id)
  if (!bounds) return null
  const { camera } = doc
  const top = (bounds.y - camera.y) * camera.zoom
  const bottom = (bounds.y + bounds.h - camera.y) * camera.zoom
  const source = canvasImageSource(doc, element.id)
  const sourceMissing = source ? undefined : t('imageToolbar.sourceMissing')
  const natural = canvasImageDimensions(element, doc)
  const refusal = inpaintRefusal(element, natural, settings)
  const fullRect = { x: 0, y: 0, w: element.width, h: element.height }

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('imageToolbar.aria')}
        className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-md"
        style={{
          left: Math.max(8, (bounds.x - camera.x) * camera.zoom),
          top:
            bottom + TOOLBAR_GAP + TOOLBAR_HEIGHT <= doc.viewport.height
              ? bottom + TOOLBAR_GAP
              : Math.max(8, top - TOOLBAR_GAP - TOOLBAR_HEIGHT),
        }}
        onPointerDown={(event) => event.stopPropagation()}
        // 空格、方向键在画布上是平移 / 移动的快捷键，按在工具条按钮上不该漏过去。
        onKeyDown={(event) => event.stopPropagation()}
      >
        <CanvasToolbarButton
          icon={<Brush />}
          label={t('inpaint.action')}
          reason={refusal ?? undefined}
          onClick={() => openInpaint(element.id, 'inpaint')}
        />
        <CanvasToolbarButton
          icon={<Eraser />}
          label={t('erase.action')}
          reason={refusal ?? undefined}
          onClick={() => openInpaint(element.id, 'erase')}
        />
        <CanvasToolbarButton
          icon={<RotateCcw />}
          label={t('regenerate.action')}
          reason={regenerateRefusal(element, settings) ?? undefined}
          onClick={() => regenerateCanvasImage(editor, element)}
        />
        <CanvasToolbarButton
          icon={<Crop />}
          label={t('crop.action')}
          onClick={() => openRect('crop', element.id, fullRect)}
        />
        <CanvasToolbarButton
          icon={<Expand />}
          label={t('outpaint.action')}
          reason={outpaintRefusal(element, settings) ?? undefined}
          onClick={() => openRect('outpaint', element.id, fullRect)}
        />
        <CanvasToolbarButton
          icon={<Copy />}
          label={t('imageMenu.copy')}
          reason={sourceMissing}
          onClick={() => void copyCanvasImage(source ?? '')}
        />
        <CanvasToolbarButton
          icon={<Download />}
          label={t('imageMenu.download')}
          reason={sourceMissing}
          onClick={() => void downloadCanvasImage(source ?? '', element.id)}
        />
        <CanvasToolbarButton
          icon={<MoreHorizontal />}
          label={t('imageToolbar.more')}
          onClick={(button) => {
            const rect = button.getBoundingClientRect()
            setMenu({ id: element.id, x: rect.left, y: rect.bottom + 4 })
          }}
        />
      </div>
      <CanvasImageMenu menu={menu} doc={doc} onClose={() => setMenu(null)} />
    </>
  )
}
