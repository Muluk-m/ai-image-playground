import { EXPORT_PRESETS, type ExportPreset, findExportPreset } from '@image-playground/shared'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Pending from '../../../components/Pending'
import { CARD, LABEL, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { formatElapsed } from '../../../hooks/useElapsed'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import {
  type CropOffset,
  EXPORT_FIT_LABELS,
  EXPORT_FITS,
  type ExportFit,
} from '../../../lib/imageExport'
import { defaultExportFit } from '../lib/exportPresets'
import { downloadSetZip, downloadShotImage } from '../lib/exportSet'
import {
  indexTasksById,
  SHOT_STATE_LABELS,
  type ShotProgress,
  type ShotState,
  shotProgress,
} from '../lib/progress'
import { canGenerateShot } from '../lib/shots'
import { useRemixStore } from '../store'
import { type RemixShot, SHOT_TYPE_LABELS } from '../types'

const STATE_STYLES: Record<ShotState, string> = {
  idle: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
  queued: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
  running: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  done: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  error: 'bg-red-500/10 text-red-700 dark:text-red-300',
}

const EMPTY_PROGRESS: ShotProgress = {
  state: 'idle',
  error: null,
  outputImageIds: [],
  startedAt: null,
  elapsed: null,
}

const SELECT =
  'rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-800 focus:border-blue-400 focus:outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100'

const GHOST_BUTTON =
  'rounded-lg px-2 py-1 text-xs text-blue-600 transition hover:bg-blue-500/10 disabled:opacity-40 dark:text-blue-300'

function presetFor(id: string): ExportPreset {
  return findExportPreset(id) ?? (EXPORT_PRESETS[0] as ExportPreset)
}

function StateBadge({ progress }: { progress: ShotProgress }) {
  const label = SHOT_STATE_LABELS[progress.state]
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLES[progress.state]}`}>
      {progress.state === 'running' ? (
        <Pending label={label} startedAt={progress.startedAt} />
      ) : progress.elapsed === null ? (
        label
      ) : (
        `${label} · ${formatElapsed(progress.elapsed)}`
      )}
    </span>
  )
}

function ShotRow({
  shot,
  index,
  preset,
  offset,
  fit,
  onFitChange,
  progress,
}: {
  shot: RemixShot
  index: number
  preset: ExportPreset
  offset: CropOffset
  fit: ExportFit
  onFitChange: (fit: ExportFit) => void
  progress: ShotProgress
}) {
  const regenerateShot = useRemixStore((s) => s.regenerateShot)

  return (
    <li className={`${CARD} flex flex-col gap-3 sm:flex-row sm:items-start`}>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
            {String(index + 1).padStart(2, '0')} · {SHOT_TYPE_LABELS[shot.type]}
          </span>
          <StateBadge progress={progress} />
        </div>
        {progress.error && (
          <p className="break-words text-xs text-red-600 dark:text-red-300">{progress.error}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {progress.outputImageIds.map((imageId) => (
            <div
              key={imageId}
              className="h-20 w-20 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]"
            >
              <AssetThumb imageId={imageId} alt={`${SHOT_TYPE_LABELS[shot.type]} 结果`} />
            </div>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <select
          value={fit}
          aria-label={`第 ${index + 1} 镜导出方式`}
          onChange={(event) => onFitChange(event.target.value as ExportFit)}
          className={`${SELECT} text-xs`}
        >
          {EXPORT_FITS.map((option) => (
            <option key={option} value={option}>
              {EXPORT_FIT_LABELS[option]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void regenerateShot(shot.id)}
          disabled={progress.state === 'running' || !canGenerateShot(shot)}
          className={GHOST_BUTTON}
        >
          重新生成
        </button>
        <button
          type="button"
          disabled={progress.outputImageIds.length === 0}
          onClick={() => {
            const imageId = progress.outputImageIds[0]
            if (!imageId) return
            void downloadShotImage(
              { shotIndex: index, shotType: shot.type, imageIds: progress.outputImageIds, fit },
              imageId,
              preset,
              offset,
            )
          }}
          className={GHOST_BUTTON}
        >
          下载
        </button>
      </div>
    </li>
  )
}

export default function RemixGenerateStep() {
  const draft = useRemixStore((s) => s.draft)
  const perShotCount = useRemixStore((s) => s.perShotCount)
  const generating = useRemixStore((s) => s.generating)
  const queuedShotIds = useRemixStore(useShallow((s) => s.queuedShotIds))
  const setPerShotCount = useRemixStore((s) => s.setPerShotCount)
  const generateSet = useRemixStore((s) => s.generateSet)
  const tasks = useStore((s) => s.tasks)
  const showToast = useStore((s) => s.showToast)
  const [presetId, setPresetId] = useState(() => presetFor(draft.settings.platform).id)
  const [exporting, setExporting] = useState(false)
  const [offset, setOffset] = useState<CropOffset>({ x: 0, y: 0 })
  const [fits, setFits] = useState<Record<string, ExportFit>>({})

  const preset = presetFor(presetId)
  const fitFor = (shot: RemixShot): ExportFit => fits[shot.id] ?? defaultExportFit(shot.type)
  const tasksById = useMemo(() => indexTasksById(tasks), [tasks])
  const progressByShotId = useMemo(
    () =>
      new Map(draft.shots.map((shot) => [shot.id, shotProgress(shot, tasksById, queuedShotIds)])),
    [draft.shots, tasksById, queuedShotIds],
  )
  const runnable = draft.shots.filter((shot) => shot.enabled && canGenerateShot(shot))
  const done = runnable.filter((shot) => progressByShotId.get(shot.id)?.state === 'done').length

  if (!draft.id) {
    return (
      <div className={`${CARD} text-center text-sm text-gray-500 dark:text-gray-400`}>
        先在步骤①保存一个套
      </div>
    )
  }

  const exportSet = async () => {
    setExporting(true)
    try {
      const shots = draft.shots.map((shot, shotIndex) => ({
        shotIndex,
        shotType: shot.type,
        imageIds: progressByShotId.get(shot.id)?.outputImageIds ?? [],
        fit: fitFor(shot),
      }))
      const result = await downloadSetZip(draft.name, shots, preset, offset)
      showToast(
        result.count > 0 ? `已打包 ${result.count} 张` : '这套还没有可导出的图',
        result.count > 0 ? 'success' : 'error',
      )
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={`${CARD} flex flex-wrap items-center gap-3`}>
        <button
          type="button"
          onClick={() => void generateSet()}
          disabled={generating}
          className={PRIMARY_BUTTON}
        >
          {generating ? <Pending label="生成中" startedAt={null} /> : '开始生成'}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          每镜张数
          <input
            type="number"
            min={1}
            max={4}
            value={perShotCount}
            aria-label="每镜张数"
            onChange={(event) => setPerShotCount(Number(event.target.value) || 1)}
            className="w-14 rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-800 focus:border-blue-400 focus:outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100"
          />
        </label>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          本套 {runnable.length * perShotCount} 张 · 完成 {done}/{runnable.length}
        </span>
      </div>

      <div className={`${CARD} flex flex-wrap items-center gap-3`}>
        <span className={LABEL}>导出尺寸</span>
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
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          水平
          <input
            type="range"
            min={-1}
            max={1}
            step={0.1}
            value={offset.x}
            aria-label="裁切水平偏移"
            onChange={(event) => setOffset((o) => ({ ...o, x: Number(event.target.value) }))}
            className="w-24 accent-blue-500"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          垂直
          <input
            type="range"
            min={-1}
            max={1}
            step={0.1}
            value={offset.y}
            aria-label="裁切垂直偏移"
            onChange={(event) => setOffset((o) => ({ ...o, y: Number(event.target.value) }))}
            className="w-24 accent-blue-500"
          />
        </label>
        <button
          type="button"
          onClick={() => void exportSet()}
          disabled={exporting}
          className={PRIMARY_BUTTON}
        >
          {exporting ? '打包中' : '打包下载'}
        </button>
      </div>

      {draft.shots.length === 0 ? (
        <div className={`${CARD} text-center text-sm text-gray-500 dark:text-gray-400`}>
          先在步骤②生成镜头
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {draft.shots.map((shot, index) => (
            <ShotRow
              key={shot.id}
              shot={shot}
              index={index}
              preset={preset}
              offset={offset}
              fit={fitFor(shot)}
              onFitChange={(fit) => setFits((current) => ({ ...current, [shot.id]: fit }))}
              progress={progressByShotId.get(shot.id) ?? EMPTY_PROGRESS}
            />
          ))}
        </ol>
      )}
    </div>
  )
}
