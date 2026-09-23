import { Copy, Download, Trash2, WandSparkles, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import { duplicateSelection } from '../lib/canvasClipboard'
import type { CanvasEditor } from '../lib/editor'
import { exportableElements, exportCanvasSelection } from '../lib/exportImages'
import { projectDisplayName } from '../lib/projectRepository'
import { useCanvasProjectStore } from '../projectStore'
import CanvasBatchPromptDialog from './CanvasBatchPromptDialog'

/**
 * 多选（两件以上）时浮在画布底部的批量操作条：导出、复制一份、删除。
 * 单选的动作各有自己的入口（右键菜单、视频工具条），这里只管「一批」。
 */
export default function CanvasBatchBar({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  const doc = editor.doc
  useSyncExternalStore(doc.subscribe, () => doc.version)
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [generating, setGenerating] = useState(false)

  const selection = [...doc.selection]
  // 画笔 / 橡皮这些工具下没有「选区操作」可言，工具条也不该压住画布下沿。
  if (doc.tool !== 'select' || selection.length < 2 || doc.editingTextId) return null
  const exportable = exportableElements(doc, selection)
  // 批量生成只对静态图成立：视频段要重新生成走它自己的工具条。
  const imageEntries = exportable.filter((el) => !el.video).length

  const runExport = async () => {
    if (progress) return
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

  return (
    <>
      {generating && (
        <CanvasBatchPromptDialog
          editor={editor}
          imageCount={imageEntries}
          onClose={() => setGenerating(false)}
        />
      )}
      <div
        role="toolbar"
        aria-label={t('batch.aria')}
        className="pointer-events-auto absolute bottom-6 left-1/2 z-[400] flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-sidebar p-1.5 shadow-lg backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <span className="px-2 text-xs text-muted-foreground tabular-nums">
          {t('batch.selected', { count: selection.length })}
        </span>
        {imageEntries >= 2 && (
          <button
            type="button"
            onClick={() => setGenerating(true)}
            title={t('batch.generate', { count: imageEntries })}
            className="flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <WandSparkles className="h-4 w-4" aria-hidden="true" />
            {t('batch.generate', { count: imageEntries })}
          </button>
        )}
        <button
          type="button"
          onClick={() => void runExport()}
          disabled={exportable.length === 0 || progress !== null}
          title={
            exportable.length === 0
              ? t('batch.nothingToExport')
              : t('batch.export', { count: exportable.length })
          }
          className="flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {progress
            ? t('batch.exporting', { done: progress.done, total: progress.total })
            : t('batch.export', { count: exportable.length })}
        </button>
        <button
          type="button"
          onClick={() => duplicateSelection(doc)}
          title={t('toolbar.duplicate')}
          aria-label={t('toolbar.duplicate')}
          className="grid h-9 w-9 place-items-center rounded-xl text-foreground transition-colors hover:bg-muted"
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => doc.deleteSelection()}
          title={t('toolbar.deleteSelected')}
          aria-label={t('toolbar.deleteSelected')}
          className="grid h-9 w-9 place-items-center rounded-xl text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          type="button"
          onClick={() => doc.setSelection([])}
          title={t('batch.clear')}
          aria-label={t('batch.clear')}
          className="grid h-9 w-9 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </>
  )
}
