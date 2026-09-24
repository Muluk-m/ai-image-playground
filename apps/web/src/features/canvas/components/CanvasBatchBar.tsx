import {
  Brush,
  Copy,
  Crop,
  Download,
  Eraser,
  Expand,
  MoreHorizontal,
  Ratio,
  Scissors,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { useInpaintSession } from '../inpaintStore'
import { duplicateSelection } from '../lib/canvasClipboard'
import type { ImageEl } from '../lib/canvasDoc'
import {
  cutoutRefusal,
  imageEditRefusal,
  outpaintRefusal,
  resizeRefusal,
  submitCanvasCutout,
} from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'
import { exportableElements, exportCanvasSelection } from '../lib/exportImages'
import { canvasImageDimensions } from '../lib/imageInfo'
import { projectDisplayName } from '../lib/projectRepository'
import { inpaintRefusal } from '../lib/submitInpaint'
import { useCanvasProjectStore } from '../projectStore'
import { useRectEdit } from '../rectEditStore'
import CanvasBatchEditDialog from './CanvasBatchEditDialog'
import CanvasBatchResizeMenu from './CanvasBatchResizeMenu'
import CanvasToolbarButton from './CanvasToolbarButton'

type SpatialAction = 'inpaint' | 'erase' | 'crop' | 'outpaint'
interface SpatialQueue {
  kind: SpatialAction
  ids: readonly string[]
  next: number
}

/**
 * 多选工具条与单图工具条同一组动作。涂抹、擦除、裁切、扩图的区域不能从一张图
 * 擅自复制到另一张图，因此逐张打开各自的选区；抠图、整图编辑与换比例逐张起任务。
 * 导出 / 复制 / 删除 / 取消选择收到「更多」，不再占满底栏。
 */
export default function CanvasBatchBar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  const doc = editor.doc
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const settings = useStore((state) => state.settings)
  const openInpaint = useInpaintSession((state) => state.open)
  const activeInpaintId = useInpaintSession((state) => state.imageId)
  const openRect = useRectEdit((state) => state.open)
  const activeRectId = useRectEdit((state) => state.imageId)
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null)
  const [resizeAt, setResizeAt] = useState<{ x: number; y: number } | null>(null)
  const [spatialQueue, setSpatialQueue] = useState<SpatialQueue | null>(null)

  const selection = [...doc.selection]
  const images = selection
    .map((id) => doc.getElement(id))
    .filter((el): el is ImageEl => el?.type === 'image' && !el.video)
  const exportable = exportableElements(doc, selection)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: images.length,
  })
  const currentSpatialId =
    spatialQueue?.kind === 'inpaint' || spatialQueue?.kind === 'erase'
      ? activeInpaintId
      : activeRectId

  useEffect(() => {
    if (!spatialQueue || currentSpatialId) return
    for (let index = spatialQueue.next; index < spatialQueue.ids.length; index++) {
      const el = editor.getElement(spatialQueue.ids[index])
      if (el?.type !== 'image' || el.video) continue
      if (spatialQueue.kind === 'inpaint' || spatialQueue.kind === 'erase')
        openInpaint(el.id, spatialQueue.kind)
      else openRect(spatialQueue.kind, el.id, { x: 0, y: 0, w: el.width, h: el.height })
      setSpatialQueue({ ...spatialQueue, next: index + 1 })
      return
    }
    setSpatialQueue(null)
  }, [spatialQueue, currentSpatialId, editor, openInpaint, openRect])

  // 两种逐张选区会话盖在画布上，此时底栏让位；关闭当前图后再打开下一张。
  if (
    doc.tool !== 'select' ||
    selection.length < 2 ||
    doc.editingTextId ||
    activeInpaintId ||
    activeRectId
  )
    return null

  const refusal = (check: (image: ImageEl) => string | null) =>
    images.map(check).find((reason) => reason !== null) ?? undefined
  const modelReason = guard.blocked ? (guard.disabledReason ?? t('submit.blocked')) : undefined
  const inpaintReason =
    images.length < 2
      ? t('batch.needImages')
      : (modelReason ??
        refusal((image) => inpaintRefusal(image, canvasImageDimensions(image, doc), settings)))
  const cutoutReason =
    images.length < 2
      ? t('batch.needImages')
      : (modelReason ?? refusal((image) => cutoutRefusal(image, settings)))
  const editReason =
    images.length < 2
      ? t('batch.needImages')
      : (modelReason ?? refusal((image) => imageEditRefusal(image, settings)))
  const outpaintReason =
    images.length < 2
      ? t('batch.needImages')
      : (modelReason ?? refusal((image) => outpaintRefusal(image, settings)))
  const resizeReason =
    images.length < 2
      ? t('batch.needImages')
      : (modelReason ?? refusal((image) => resizeRefusal(image, settings)))
  const cropReason = images.length < 2 ? t('batch.needImages') : undefined

  const runExport = async () => {
    if (progress || exportable.length === 0) return
    setProgress({ done: 0, total: exportable.length })
    try {
      await exportCanvasSelection(doc, selection, {
        onProgress: (done, total) => setProgress({ done, total }),
        baseName: project ? projectDisplayName(project.name) : undefined,
      })
    } finally {
      setProgress(null)
    }
  }
  const startSpatial = (kind: SpatialAction) => {
    setSpatialQueue({ kind, ids: images.map((image) => image.id), next: 0 })
  }
  const runCutout = async () => {
    for (const image of images) {
      const current = editor.getElement(image.id)
      if (current?.type !== 'image' || current.video) continue
      if (!(await submitCanvasCutout(editor, current))) break
    }
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('batch.aria')}
        className="pointer-events-auto absolute bottom-6 left-1/2 z-[400] flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-2xl border border-border bg-sidebar p-1.5 shadow-lg backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <span className="shrink-0 px-2 text-xs text-muted-foreground tabular-nums">
          {t('batch.selected', { count: selection.length })}
        </span>
        <CanvasToolbarButton
          compact
          icon={<Brush />}
          label={t('inpaint.action')}
          reason={inpaintReason}
          onClick={() => startSpatial('inpaint')}
        />
        <CanvasToolbarButton
          compact
          icon={<Eraser />}
          label={t('erase.action')}
          reason={inpaintReason}
          onClick={() => startSpatial('erase')}
        />
        <CanvasToolbarButton
          compact
          icon={<Scissors />}
          label={t('cutout.action')}
          reason={cutoutReason}
          onClick={() => void runCutout()}
        />
        <CanvasToolbarButton
          compact
          icon={<Wand2 />}
          label={t('imageEdit.action')}
          reason={editReason}
          onClick={() => setEditing(true)}
        />
        <CanvasToolbarButton
          compact
          icon={<Crop />}
          label={t('crop.action')}
          reason={cropReason}
          onClick={() => startSpatial('crop')}
        />
        <CanvasToolbarButton
          compact
          icon={<Expand />}
          label={t('outpaint.action')}
          reason={outpaintReason}
          onClick={() => startSpatial('outpaint')}
        />
        <CanvasToolbarButton
          compact
          icon={<Ratio />}
          label={t('resize.action')}
          reason={resizeReason}
          onClick={(button) => {
            const rect = button.getBoundingClientRect()
            setResizeAt({ x: rect.left, y: rect.bottom + 4 })
          }}
        />
        <CanvasToolbarButton
          compact
          icon={<MoreHorizontal />}
          label={t('imageToolbar.more')}
          onClick={(button) => {
            const rect = button.getBoundingClientRect()
            setMoreAt({ x: rect.left, y: rect.bottom + 4 })
          }}
        />
      </div>
      {editing && (
        <CanvasBatchEditDialog editor={editor} images={images} onClose={() => setEditing(false)} />
      )}
      {resizeAt && (
        <CanvasBatchResizeMenu
          editor={editor}
          images={images}
          {...resizeAt}
          onClose={() => setResizeAt(null)}
        />
      )}
      {moreAt && (
        <ContextMenu {...moreAt} onClose={() => setMoreAt(null)}>
          {exportable.length > 0 && (
            <ContextMenuItem
              icon={<Download className="h-4 w-4" />}
              label={
                progress
                  ? t('batch.exporting', progress)
                  : t('batch.export', { count: exportable.length })
              }
              onClick={() => {
                setMoreAt(null)
                void runExport()
              }}
            />
          )}
          <ContextMenuItem
            icon={<Copy className="h-4 w-4" />}
            label={t('toolbar.duplicate')}
            onClick={() => {
              setMoreAt(null)
              duplicateSelection(doc)
            }}
          />
          <ContextMenuItem
            icon={<Trash2 className="h-4 w-4" />}
            label={t('toolbar.deleteSelected')}
            onClick={() => {
              setMoreAt(null)
              doc.deleteSelection()
            }}
          />
          <ContextMenuItem
            icon={<X className="h-4 w-4" />}
            label={t('batch.clear')}
            onClick={() => {
              setMoreAt(null)
              doc.setSelection([])
            }}
          />
        </ContextMenu>
      )}
    </>
  )
}
