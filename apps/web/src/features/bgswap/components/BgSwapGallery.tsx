import { EXPORT_PRESETS, type ExportPreset, findExportPreset } from '@image-playground/shared'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Pending from '../../../components/Pending'
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
  exportBlockedReason,
  exportPlan,
  flatVersions,
  type GalleryVersion,
  galleryRows,
  hasChosenVersion,
  type ManualExportScope,
  resolveExportScope,
} from '../lib/gallery'
import { VERSION_STATE_LABELS } from '../lib/versionProgress'
import { useBgSwapStore } from '../store'

const VIEWS = ['grouped', 'flat'] as const
type GalleryView = (typeof VIEWS)[number]
const VIEW_LABELS: Record<GalleryView, string> = { grouped: '分组', flat: '平铺' }

const HINT = 'rounded bg-amber-500/10 px-1 text-xs text-amber-700 dark:text-amber-300'

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onChange: (option: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-900"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`${SEGMENT} ${value === option ? ACTIVE_SEGMENT : IDLE_SEGMENT}`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  const showToast = useStore((s) => s.showToast)
  const matteOverlayVersionId = useBgSwapStore((s) => s.matteOverlayVersionId)
  const toggleMatteOverlay = useBgSwapStore((s) => s.toggleMatteOverlay)
  const [first] = item.outputImageIds
  const label = `原图 ${item.imageIndex + 1} 第 ${item.versionIndex + 1} 版`
  const matte = item.version.mattePreviewImageId
  const overlaid = matte !== undefined && matteOverlayVersionId === item.version.id

  return (
    <li data-bgswap-gallery-item className="flex w-28 shrink-0 flex-col gap-1">
      <div className="relative aspect-square overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
        {overlaid ? (
          <>
            <AssetThumb imageId={item.imageId} alt={label} />
            <span className="absolute inset-0">
              <AssetThumb imageId={matte} alt="蒙版" />
            </span>
          </>
        ) : first ? (
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
        {matte && (
          <button
            type="button"
            onClick={() => toggleMatteOverlay(item.version.id)}
            aria-pressed={overlaid}
            className={GHOST_BUTTON}
          >
            看蒙版
          </button>
        )}
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
                downloadExportedImage(
                  bgSwapFileName(item.imageIndex, item.versionIndex),
                  first,
                  fit,
                  preset,
                ).catch((error: unknown) => showToast(`下载失败：${reasonOf(error)}`, 'error'))
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
  const [manualScope, setManualScope] = useState<ManualExportScope | null>(null)
  const [fit, setFit] = useState<ExportFit>('crop')
  const [exportStartedAt, setExportStartedAt] = useState<number | null>(null)

  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const rows = useMemo(() => galleryRows(images, tasksById), [images, tasksById])
  const preset = findExportPreset(presetId) ?? (EXPORT_PRESETS[0] as ExportPreset)

  const hasChosen = hasChosenVersion(rows)
  const scope = resolveExportScope(hasChosen, manualScope)
  const plan = useMemo(() => exportPlan(jobName, rows, scope, fit), [jobName, rows, scope, fit])
  const blocked = exportBlockedReason(scope, hasChosen, plan.entries.length)

  const exportAll = async () => {
    setExportStartedAt(Date.now())
    try {
      const result = await downloadExportZip(jobName, plan.entries, preset)
      // 渲染失败的那几张与本来就没出图的版本对用户是同一件事：这次没打进去。
      const left = plan.skipped + result.failed
      const missing = left > 0 ? `，已跳过 ${left} 个未完成版本` : ''
      showToast(
        result.count > 0 ? `已打包 ${result.count} 张${missing}` : `没有可导出的图${missing}`,
        result.count > 0 ? 'success' : 'error',
      )
    } catch (error) {
      showToast(`打包失败：${reasonOf(error)}`, 'error')
    } finally {
      setExportStartedAt(null)
    }
  }

  return (
    <section data-bgswap-gallery className={`${CARD} mt-4 flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">结果总览</h2>
        <Segmented
          label="总览排布"
          options={VIEWS}
          labels={VIEW_LABELS}
          value={view}
          onChange={setView}
        />
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
        <Segmented
          label="导出范围"
          options={EXPORT_SCOPES}
          labels={EXPORT_SCOPE_LABELS}
          value={scope}
          onChange={(option: ExportScope) => setManualScope({ scope: option, hasChosen })}
        />
        {!hasChosen && scope === 'all' && !blocked && (
          <span className={HINT}>未选用，导出全部</span>
        )}
        <Segmented
          label="导出方式"
          options={EXPORT_FITS}
          labels={EXPORT_FIT_LABELS}
          value={fit}
          onChange={setFit}
        />
        <button
          type="button"
          onClick={() => void exportAll()}
          disabled={exportStartedAt !== null || plan.entries.length === 0}
          className={PRIMARY_BUTTON}
        >
          {exportStartedAt === null ? (
            `打包下载 ${plan.entries.length} 张`
          ) : (
            <Pending label="打包中" startedAt={exportStartedAt} />
          )}
        </button>
        {blocked && rows.length > 0 && <span className={HINT}>{blocked}</span>}
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
