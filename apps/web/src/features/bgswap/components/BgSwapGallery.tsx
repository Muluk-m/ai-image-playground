import { EXPORT_PRESETS, type ExportPreset, findExportPreset } from '@image-playground/shared'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ACTIVE_SEGMENT,
  CARD,
  GHOST_BUTTON,
  IDLE_SEGMENT,
  LABEL,
  PRIMARY_BUTTON,
  SEGMENT,
  SELECT,
} from '../../../components/panelStyles'
import {
  downloadExportedImage,
  downloadExportZip,
  EXPORT_FIT_LABELS,
  EXPORT_FITS,
  type ExportFit,
} from '../../../lib/imageExport'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import {
  bgSwapFileName,
  EXPORT_SCOPE_LABELS,
  EXPORT_SCOPES,
  type ExportScope,
  exportEntries,
  flatVersions,
  type GalleryVersion,
  galleryRows,
} from '../lib/gallery'
import { VERSION_STATE_LABELS } from '../lib/versionProgress'
import { useBgSwapStore } from '../store'

const VIEWS = ['grouped', 'flat'] as const
type GalleryView = (typeof VIEWS)[number]
const VIEW_LABELS: Record<GalleryView, string> = { grouped: '分组', flat: '平铺' }

function VersionCard({
  item,
  fit,
  preset,
  onChoose,
  onRetry,
}: {
  item: GalleryVersion
  fit: ExportFit
  preset: ExportPreset
  onChoose: () => void
  onRetry: () => void
}) {
  const [first] = item.outputImageIds
  const label = `原图 ${item.imageIndex + 1} 第 ${item.versionIndex + 1} 版`

  return (
    <li data-bgswap-gallery-item className="flex w-28 shrink-0 flex-col gap-1">
      <div className="aspect-square overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
        {first ? (
          <AssetThumb imageId={first} alt={label} />
        ) : (
          <span className="flex h-full items-center justify-center text-xs text-gray-400 dark:text-gray-500">
            {VERSION_STATE_LABELS[item.state]}
          </span>
        )}
      </div>
      <span className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
        第 {item.versionIndex + 1} 版
        {item.chosen && (
          <span className="rounded bg-blue-500/10 px-1 text-blue-700 dark:text-blue-300">已选</span>
        )}
        {!item.version.masked && (
          <span className="rounded bg-amber-500/10 px-1 text-amber-700 dark:text-amber-300">
            未抠图
          </span>
        )}
      </span>
      <div className="flex gap-0.5">
        {item.state === 'error' && (
          <button type="button" onClick={onRetry} className={GHOST_BUTTON}>
            重跑
          </button>
        )}
        {first && (
          <>
            {!item.chosen && (
              <button type="button" onClick={onChoose} className={GHOST_BUTTON}>
                用这版
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void downloadExportedImage(
                  bgSwapFileName(item.imageIndex, item.versionIndex),
                  first,
                  fit,
                  preset,
                )
              }}
              className={GHOST_BUTTON}
            >
              下载
            </button>
          </>
        )}
      </div>
    </li>
  )
}

export default function BgSwapGallery() {
  const images = useBgSwapStore(useShallow((s) => s.draft.images))
  const jobName = useBgSwapStore((s) => s.draft.name)
  const tasks = useStore((s) => s.tasks)
  const showToast = useStore((s) => s.showToast)
  const chooseVersion = useBgSwapStore((s) => s.chooseVersion)
  const retryVersion = useBgSwapStore((s) => s.retryVersion)
  const [view, setView] = useState<GalleryView>('grouped')
  const [presetId, setPresetId] = useState(EXPORT_PRESETS[0]?.id ?? 'amazon')
  const [scope, setScope] = useState<ExportScope>('chosen')
  const [fit, setFit] = useState<ExportFit>('crop')
  const [exporting, setExporting] = useState(false)

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const rows = useMemo(() => galleryRows(images, tasksById), [images, tasksById])
  const preset = findExportPreset(presetId) ?? (EXPORT_PRESETS[0] as ExportPreset)

  const exportAll = async () => {
    setExporting(true)
    try {
      const result = await downloadExportZip(
        jobName,
        exportEntries(jobName, rows, scope, fit),
        preset,
      )
      showToast(
        result.count > 0 ? `已打包 ${result.count} 张` : '没有可导出的图',
        result.count > 0 ? 'success' : 'error',
      )
    } finally {
      setExporting(false)
    }
  }

  return (
    <section data-bgswap-gallery className={`${CARD} mt-4 flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">结果总览</h2>
        <div className="flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-900">
          {VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              aria-pressed={view === option}
              className={`${SEGMENT} ${view === option ? ACTIVE_SEGMENT : IDLE_SEGMENT}`}
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={LABEL}>导出</span>
        <select
          value={presetId}
          aria-label="导出尺寸"
          onChange={(event) => setPresetId(event.target.value)}
          className={SELECT}
        >
          {EXPORT_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={scope}
          aria-label="导出范围"
          onChange={(event) => setScope(event.target.value as ExportScope)}
          className={SELECT}
        >
          {EXPORT_SCOPES.map((option) => (
            <option key={option} value={option}>
              {EXPORT_SCOPE_LABELS[option]}
            </option>
          ))}
        </select>
        <select
          value={fit}
          aria-label="导出方式"
          onChange={(event) => setFit(event.target.value as ExportFit)}
          className={SELECT}
        >
          {EXPORT_FITS.map((option) => (
            <option key={option} value={option}>
              {EXPORT_FIT_LABELS[option]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void exportAll()}
          disabled={exporting || rows.length === 0}
          className={PRIMARY_BUTTON}
        >
          {exporting ? '打包中' : '打包下载'}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">暂无结果</p>
      ) : view === 'flat' ? (
        <ul className="flex flex-wrap gap-3">
          {flatVersions(rows).map((item) => (
            <VersionCard
              key={item.version.id}
              item={item}
              fit={fit}
              preset={preset}
              onChoose={() => chooseVersion(item.version.id)}
              onRetry={() => void retryVersion(item.version.id)}
            />
          ))}
        </ul>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.imageId}
              data-bgswap-gallery-row
              className="flex flex-col gap-2 border-t border-gray-200/70 pt-3 first:border-0 first:pt-0 dark:border-white/[0.08] sm:flex-row sm:items-start sm:gap-3"
            >
              <div className="flex w-28 shrink-0 flex-col gap-1">
                <div className="aspect-square overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
                  <AssetThumb imageId={row.imageId} alt={`原图 ${row.imageIndex + 1}`} />
                </div>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  原图 {row.imageIndex + 1}
                </span>
              </div>
              <ul className="flex min-w-0 flex-1 flex-wrap gap-3">
                {row.versions.map((item) => (
                  <VersionCard
                    key={item.version.id}
                    item={item}
                    fit={fit}
                    preset={preset}
                    onChoose={() => chooseVersion(item.version.id)}
                    onRetry={() => void retryVersion(item.version.id)}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
