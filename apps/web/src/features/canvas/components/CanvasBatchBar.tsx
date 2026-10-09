import { Download, Ratio, Scissors, Trash2, Wand2, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { canvasExportSources } from '../../image-export/sources'
import { openImageExport } from '../../image-export/store'
import type { ImageEl } from '../lib/canvasDoc'
import {
  cutoutRefusal,
  imageEditRefusal,
  type ResizeRatio,
  resizeRefusal,
  submitCanvasCutout,
  submitCanvasResize,
} from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'
import { exportableElements } from '../lib/exportImages'
import { projectDisplayName } from '../lib/projectRepository'
import { useCanvasProjectStore } from '../projectStore'
import CanvasBatchConfirmDialog from './CanvasBatchConfirmDialog'
import CanvasBatchEditDialog from './CanvasBatchEditDialog'
import CanvasBatchResizeMenu from './CanvasBatchResizeMenu'
import CanvasToolbarButton from './CanvasToolbarButton'

/**
 * 多选工具条：直接展示对一批成立的动作——抠图、整图编辑、换比例、导出、删除与取消选择。
 * 局部重绘 / 擦除 / 裁切 / 扩图要先在某一张图上画出区域，区域换一张图就没有意义，
 * 它们只属于单图工具条。
 */
export default function CanvasBatchBar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  const doc = editor.doc
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const settings = useStore((state) => state.settings)
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const [editing, setEditing] = useState(false)
  const [resizeAt, setResizeAt] = useState<{ x: number; y: number } | null>(null)
  /** 等用户确认的批量 AI 动作；确认前不发任何任务。 */
  const [pending, setPending] = useState<
    { kind: 'cutout' } | { kind: 'resize'; ratio: ResizeRatio } | null
  >(null)

  const selection = [...doc.selection]
  const images = selection
    .map((id) => doc.getElement(id))
    .filter((el): el is ImageEl => el?.type === 'image' && !el.video)
  const exportable = exportableElements(doc, selection)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: images.length,
  })

  if (doc.tool !== 'select' || selection.length < 2 || doc.editingTextId) return null

  const modelReason = guard.blocked ? (guard.disabledReason ?? t('submit.blocked')) : undefined
  /** 整批能不能做这件事：少于两张图、门禁拦着、或任一张图自己不行，都给出第一条原因。 */
  const batchRefusal = (check: (image: ImageEl) => string | null) => {
    if (images.length < 2) return t('batch.needImages')
    return modelReason ?? images.map(check).find((reason) => reason !== null) ?? undefined
  }

  const runExport = () => {
    openImageExport(
      canvasExportSources(doc, selection),
      project ? projectDisplayName(project.name) : undefined,
    )
  }
  /** 逐张提交；某张发不出去（门禁、额度）就停，不把剩下的继续往外扔。 */
  const runEach = async (submit: (image: ImageEl) => Promise<boolean>) => {
    for (const image of images) {
      const current = editor.getElement(image.id)
      if (current?.type !== 'image' || current.video) continue
      if (!(await submit(current))) break
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
          icon={<Scissors />}
          label={t('cutout.action')}
          reason={batchRefusal((image) => cutoutRefusal(image, settings))}
          onClick={() => setPending({ kind: 'cutout' })}
        />
        <CanvasToolbarButton
          compact
          icon={<Wand2 />}
          label={t('imageEdit.action')}
          reason={batchRefusal((image) => imageEditRefusal(image, settings))}
          onClick={() => setEditing(true)}
        />
        <CanvasToolbarButton
          compact
          icon={<Ratio />}
          label={t('resize.action')}
          reason={batchRefusal((image) => resizeRefusal(image, settings))}
          onClick={(button) => {
            const rect = button.getBoundingClientRect()
            setResizeAt({ x: rect.left, y: rect.bottom + 4 })
          }}
        />
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
        <CanvasToolbarButton
          compact
          icon={<Download />}
          label={
            exportable.length > 0
              ? t('batch.export', { count: exportable.length })
              : t('batch.nothingToExport')
          }
          reason={exportable.length === 0 ? t('batch.nothingToExport') : undefined}
          onClick={() => void runExport()}
        />
        <CanvasToolbarButton
          compact
          destructive
          icon={<Trash2 />}
          label={t('toolbar.deleteSelected')}
          onClick={() => doc.deleteSelection()}
        />
        <CanvasToolbarButton
          compact
          icon={<X />}
          label={t('batch.clear')}
          onClick={() => doc.setSelection([])}
        />
      </div>
      {editing && (
        <CanvasBatchEditDialog editor={editor} images={images} onClose={() => setEditing(false)} />
      )}
      {resizeAt && (
        <CanvasBatchResizeMenu
          {...resizeAt}
          onPick={(ratio) => setPending({ kind: 'resize', ratio })}
          onClose={() => setResizeAt(null)}
        />
      )}
      {pending && (
        <CanvasBatchConfirmDialog
          title={
            pending.kind === 'cutout'
              ? t('batch.cutoutTitle', { count: images.length })
              : t('batch.resizeTitle', { count: images.length, ratio: pending.ratio })
          }
          note={t(pending.kind === 'cutout' ? 'batch.cutoutPlacement' : 'batch.resizePlacement')}
          count={images.length}
          onConfirm={() =>
            pending.kind === 'cutout'
              ? runEach((image) => submitCanvasCutout(editor, image))
              : runEach((image) => submitCanvasResize(editor, image, pending.ratio))
          }
          onClose={() => setPending(null)}
        />
      )}
    </>
  )
}
