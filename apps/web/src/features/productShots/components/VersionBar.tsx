import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DownloadIcon, EditIcon } from '../../../components/icons'
import Pending from '../../../components/Pending'
import { CARD, GHOST_BUTTON, NOTICE, PANEL_TITLE } from '../../../components/panelStyles'
import { formatElapsed } from '../../../hooks/useElapsed'
import { downloadImagesByIds } from '../../../lib/downloadImages'
import { useStore } from '../../../store'
import AssetThumb from '../../library/components/AssetThumb'
import { changesBackground } from '../lib/mode'
import { DIAGRAM_LABEL, isDiagram } from '../lib/scene'
import { VERSION_STATE_LABELS, type VersionProgress, versionProgress } from '../lib/versionProgress'
import { useProductShotsStore } from '../store'
import { matteEditable, type ProductShotVersion } from '../types'
import { downloadKit } from '../workflows/render'
import { closeWorkflow, openWorkflow, retryProductWorkflow } from '../workflows/runtime'
import WorkflowImage from '../workflows/WorkflowImage'
import IconButton from './IconButton'
import MattedThumb from './MattedThumb'
import {
  CheckIcon,
  MaskRetryIcon,
  MatteIcon,
  PlanIcon,
  RetryIcon,
  VERSION_ACTION_ROW,
  VERSION_ICON_BUTTON,
  VersionTags,
  VersionTitle,
} from './versionParts'

/** 选用态的实心勾：深色下也不许 hover 把蓝底洗掉。 */
const CHOSEN_ICON =
  'bg-blue-500 text-white hover:bg-blue-500 hover:text-white dark:text-white dark:hover:bg-blue-500 dark:hover:text-white'

export default function VersionBar() {
  const selected = useProductShotsStore(
    useShallow((s) => s.draft.images.find((image) => image.imageId === s.selectedImageId)),
  )
  const tasks = useStore((s) => s.tasks)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])

  const rows = (selected?.versions ?? []).map((version) => ({
    version,
    progress: versionProgress(tasksById.get(version.taskId)),
  }))
  const lightboxImageIds = rows.flatMap((row) => row.progress.outputImageIds)

  return (
    <section data-product-shots-version-panel className={CARD}>
      <h2 className={PANEL_TITLE}>版本</h2>
      {selected && isDiagram(selected.sceneType) && (
        <p className="mt-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
          {DIAGRAM_LABEL}
        </p>
      )}
      {!selected || rows.length === 0 ? (
        <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">暂无版本</p>
      ) : (
        <ul data-product-shots-versions className="mt-1.5 flex flex-col gap-1.5">
          {rows.map((row, index) => (
            <VersionRow
              key={row.version.id}
              version={row.version}
              imageId={selected.imageId}
              matteEditable={matteEditable(selected.sourceMatte)}
              matteReady={selected.sourceMatte?.status === 'ready'}
              index={index}
              progress={row.progress}
              chosen={selected.chosenVersionId === row.version.id}
              onOpen={(imageId) => setLightboxImageId(imageId, lightboxImageIds)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** 完成的那一版只报耗时，「完成」和秒数说的是同一件事。 */
function statusLabel(progress: VersionProgress): string {
  const elapsed = progress.elapsed === null ? '' : formatElapsed(progress.elapsed)
  if (progress.state === 'done' && elapsed) return elapsed
  return elapsed
    ? `${VERSION_STATE_LABELS[progress.state]} ${elapsed}`
    : VERSION_STATE_LABELS[progress.state]
}

function VersionRow({
  version,
  imageId,
  matteEditable,
  matteReady,
  index,
  progress,
  chosen,
  onOpen,
}: {
  version: ProductShotVersion
  /** 这一版的原图，看蒙版时把预览盖回它上面。 */
  imageId: string
  /** 改蒙版与重生成用的是原图身上那份，不是这一版的快照。 */
  matteEditable: boolean
  /** 占比不对的那份只能改，不能拿去重生成。 */
  matteReady: boolean
  index: number
  progress: VersionProgress
  chosen: boolean
  onOpen: (imageId: string) => void
}) {
  const previewing = useProductShotsStore((s) => s.previewVersionId === version.id)
  const overlaid = useProductShotsStore(
    (s) => s.matteOverlayVersionId === version.id && version.mattePreviewImageId !== undefined,
  )
  const {
    previewVersion,
    chooseVersion,
    retryVersion,
    toggleMatteOverlay,
    editSourceMask,
    regenerateFromVersion,
    openPlanDrawer,
  } = useProductShotsStore.getState()
  const showToast = useStore((s) => s.showToast)
  const [unfolded, setUnfolded] = useState(false)
  const [unfoldedError, setUnfoldedError] = useState(false)

  const [first] = progress.outputImageIds
  const label = `第 ${index + 1} 版`
  const chooseLabel = chosen ? '取消选用' : '用这版'

  const download = async () => {
    if (!first) return
    if (version.workflow?.spec.kind === 'kit') {
      try {
        await downloadKit(`v${index + 1}`, [{ version, imageId: first }])
      } catch (error) {
        showToast(String(error), 'error')
      }
      return
    }
    const { failed } = await downloadImagesByIds([first], `v${index + 1}`)
    if (failed > 0) showToast('下载失败', 'error')
  }

  return (
    <li
      data-product-shots-version
      className={`group grid grid-cols-[72px_minmax(0,1fr)_auto] items-start gap-2 rounded-xl border p-1.5 transition ${
        chosen
          ? 'border-blue-400 bg-blue-500/5 dark:border-blue-500/50'
          : 'border-gray-200 dark:border-white/[0.08]'
      }`}
    >
      <button
        type="button"
        data-product-shots-version-preview
        onClick={() => {
          closeWorkflow()
          previewVersion(version.id)
        }}
        onDoubleClick={() => first && onOpen(first)}
        aria-pressed={previewing}
        aria-label={`预览${label}`}
        className={`relative block aspect-square w-full overflow-hidden rounded-lg border ${
          previewing
            ? 'border-blue-400 ring-1 ring-blue-400'
            : 'border-gray-200 dark:border-white/[0.08]'
        }`}
      >
        {overlaid ? (
          <MattedThumb imageId={imageId} overlayImageId={version.mattePreviewImageId} alt={label} />
        ) : first ? (
          version.workflow?.spec.kind === 'kit' ? (
            <WorkflowImage
              imageId={first}
              version={version}
              alt={label}
              className="h-full w-full object-contain"
            />
          ) : (
            <AssetThumb imageId={first} alt={label} />
          )
        ) : (
          <span className="flex h-full items-center justify-center text-[11px] text-gray-400 dark:text-gray-500">
            {VERSION_STATE_LABELS[progress.state]}
          </span>
        )}
      </button>

      <div className="flex min-w-0 flex-col gap-0.5">
        <VersionTitle
          index={index}
          version={version}
          truncateAction={false}
          trailing={
            <span className="shrink-0 text-gray-500 dark:text-gray-400">
              {progress.state === 'running' ? (
                <Pending label="生成中" startedAt={progress.startedAt} />
              ) : (
                statusLabel(progress)
              )}
            </span>
          }
        />
        <VersionTags version={version} />

        {changesBackground(version.mode) && version.plan && (
          <button
            type="button"
            data-product-shots-version-plan
            onClick={() => setUnfolded(!unfolded)}
            aria-expanded={unfolded}
            className={`text-left text-xs text-gray-600 dark:text-gray-300 ${unfolded ? '' : 'line-clamp-2'}`}
          >
            {version.plan}
          </button>
        )}

        {progress.error && (
          <p className={`flex items-baseline gap-1 ${NOTICE}`}>
            <span className={unfoldedError ? '' : 'min-w-0 flex-1 truncate'}>{progress.error}</span>
            <button
              type="button"
              data-product-shots-version-error-toggle
              onClick={() => setUnfoldedError(!unfoldedError)}
              aria-expanded={unfoldedError}
              className={`shrink-0 ${GHOST_BUTTON}`}
            >
              {unfoldedError ? '收起' : '展开'}
            </button>
          </p>
        )}
      </div>

      <div className={VERSION_ACTION_ROW}>
        {!version.workflow && (
          <IconButton
            onClick={() => openPlanDrawer(version.id)}
            label="查看方案"
            className={VERSION_ICON_BUTTON}
          >
            <PlanIcon className="h-4 w-4" />
          </IconButton>
        )}
        {version.mattePreviewImageId && (
          <IconButton
            onClick={() => toggleMatteOverlay(version.id)}
            aria-pressed={overlaid}
            label="看蒙版"
            className={`${VERSION_ICON_BUTTON} ${overlaid ? 'bg-blue-500/10 text-blue-600 dark:text-blue-300' : ''}`}
          >
            <MatteIcon className="h-4 w-4" />
          </IconButton>
        )}
        {matteEditable && !version.workflow && (
          <IconButton
            onClick={() => void editSourceMask(imageId)}
            label="编辑蒙版"
            className={VERSION_ICON_BUTTON}
          >
            <EditIcon className="h-4 w-4" />
          </IconButton>
        )}
        {matteReady && !version.workflow && (
          <IconButton
            onClick={() => void regenerateFromVersion(version.id, true)}
            label="用此蒙版重生成"
            className={VERSION_ICON_BUTTON}
          >
            <MaskRetryIcon className="h-4 w-4" />
          </IconButton>
        )}
        {first && version.workflow?.spec.kind === 'draft' && (
          <button
            type="button"
            className={GHOST_BUTTON}
            onClick={() => openWorkflow('refine', version.id)}
          >
            精修
          </button>
        )}
        {first && (
          <>
            <IconButton
              onClick={() => chooseVersion(version.id)}
              aria-pressed={chosen}
              label={chooseLabel}
              className={`${VERSION_ICON_BUTTON} ${chosen ? CHOSEN_ICON : ''}`}
            >
              <CheckIcon className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              onClick={() => void download()}
              label="下载"
              className={VERSION_ICON_BUTTON}
            >
              <DownloadIcon className="h-4 w-4" />
            </IconButton>
          </>
        )}
        {progress.state === 'error' && (
          <IconButton
            onClick={() => {
              if (version.workflow)
                void retryProductWorkflow(
                  { jobId: useProductShotsStore.getState().draft.id ?? '', imageId },
                  version,
                ).catch((e) => showToast(String(e), 'error'))
              else void retryVersion(version.id)
            }}
            label="重跑"
            className={VERSION_ICON_BUTTON}
          >
            <RetryIcon className="h-4 w-4" />
          </IconButton>
        )}
      </div>
    </li>
  )
}
