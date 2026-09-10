import { useRef, useState } from 'react'
import { CopyIcon, DownloadIcon, EditIcon, SparkleIcon } from '../../../components/icons'
import { downloadBlob, downloadImagesByIds } from '../../../lib/downloadImages'
import { useStore } from '../../../store'
import { shotFileName } from '../lib/gallery'
import type { ProductShotVersion } from '../types'
import { renderKitImage } from '../workflows/render'
import { openWorkflow } from '../workflows/runtime'

const BUTTON =
  'inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-wait disabled:opacity-50 [@media(pointer:coarse)]:min-h-11'
const SECONDARY =
  'border-gray-200 bg-white text-gray-700 hover:border-blue-300 dark:border-white/[0.12] dark:bg-white/[0.04] dark:text-gray-200 dark:hover:border-blue-400/50'

export default function PreviewToolbar({
  version,
  imageId,
  imageIndex,
  versionIndex,
  comparing,
  onCompare,
}: {
  version: ProductShotVersion
  imageId: string
  imageIndex: number
  versionIndex: number
  comparing: boolean
  onCompare: () => void
}) {
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const exportImage = async () => {
    if (exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    try {
      if (version.workflow?.spec.kind === 'kit') {
        downloadBlob(await renderKitImage(imageId, version), shotFileName(imageIndex, versionIndex))
      } else {
        const result = await downloadImagesByIds(
          [imageId],
          `product-${imageIndex + 1}-v${versionIndex + 1}`,
        )
        if (result.failed) throw new Error('图片暂不可用，请重试')
      }
    } catch (error) {
      useStore
        .getState()
        .showToast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }

  return (
    <div
      role="group"
      aria-label="图像操作"
      className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200/70 pt-3 dark:border-white/[0.08]"
    >
      <div role="group" aria-label="创作工具" className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${BUTTON} border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-400/25 dark:bg-blue-400/10 dark:text-blue-300 dark:hover:bg-blue-400/20`}
          onClick={() => openWorkflow('edit', version.id)}
        >
          <EditIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          局部编辑
        </button>
        <button
          type="button"
          className={`${BUTTON} ${SECONDARY}`}
          onClick={() => openWorkflow('kit', version.id)}
        >
          <CopyIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          批量衍生
        </button>
        {version.workflow?.spec.kind === 'draft' && (
          <button
            type="button"
            className={`${BUTTON} ${SECONDARY}`}
            onClick={() => openWorkflow('refine', version.id)}
          >
            <SparkleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            精修成品
          </button>
        )}
      </div>
      <div role="group" aria-label="查看与导出" className="ml-auto flex items-center gap-2">
        <button
          type="button"
          aria-pressed={comparing}
          className={`${BUTTON} ${comparing ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/10 dark:text-blue-300' : 'border-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.04]'}`}
          onClick={onCompare}
        >
          <svg
            className="h-4 w-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M12 4v16" />
          </svg>
          对比
        </button>
        <span aria-hidden="true" className="h-5 w-px bg-gray-200 dark:bg-white/[0.12]" />
        <button
          type="button"
          aria-busy={exporting}
          disabled={exporting}
          className={`${BUTTON} ${SECONDARY}`}
          onClick={() => void exportImage()}
        >
          <DownloadIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {exporting ? '导出中…' : '导出'}
        </button>
      </div>
    </div>
  )
}
