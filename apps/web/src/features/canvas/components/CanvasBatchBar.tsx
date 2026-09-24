import { Copy, Download, MoreHorizontal, Ratio, Scissors, Trash2, Wand2, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { duplicateSelection } from '../lib/canvasClipboard'
import type { ImageEl } from '../lib/canvasDoc'
import {
  cutoutRefusal,
  imageEditRefusal,
  resizeRefusal,
  submitCanvasCutout,
} from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'
import { exportableElements, exportCanvasSelection } from '../lib/exportImages'
import { projectDisplayName } from '../lib/projectRepository'
import { useCanvasProjectStore } from '../projectStore'
import CanvasBatchEditDialog from './CanvasBatchEditDialog'
import CanvasBatchResizeMenu from './CanvasBatchResizeMenu'
import CanvasToolbarButton from './CanvasToolbarButton'

/**
 * 多选工具条：只放**对一批成立**的动作——抠图、整图编辑、换比例，同一个指令逐张跑完。
 * 局部重绘 / 擦除 / 裁切 / 扩图要先在某一张图上画出区域，区域换一张图就没有意义，
 * 它们只属于单图工具条。导出 / 复制 / 删除 / 取消选择收进「更多」。
 */
export default function CanvasBatchBar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  const doc = editor.doc
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const settings = useStore((state) => state.settings)
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null)
  const [resizeAt, setResizeAt] = useState<{ x: number; y: number } | null>(null)

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
          icon={<Scissors />}
          label={t('cutout.action')}
          reason={batchRefusal((image) => cutoutRefusal(image, settings))}
          onClick={() => void runCutout()}
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
