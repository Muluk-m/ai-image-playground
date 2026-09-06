import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import Pending from '../../../components/Pending'
import { LABEL, NOTICE } from '../../../components/panelStyles'
import { formatElapsed } from '../../../hooks/useElapsed'
import { useStore } from '../../../store'
import { type MatteBadge, matteBadge } from '../lib/matteBadge'
import { VERSION_STATE_LABELS, versionProgress } from '../lib/versionProgress'
import { useBgSwapStore } from '../store'

const ACTION =
  'rounded-md px-2 py-0.5 text-xs text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]'

const BADGE_TONE: Record<MatteBadge['tone'], string> = {
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
}

export default function BgSwapVersionBar() {
  const selected = useBgSwapStore(
    useShallow((s) => s.draft.images.find((image) => image.imageId === s.selectedImageId)),
  )
  const previewVersionId = useBgSwapStore((s) => s.previewVersionId)
  const tasks = useStore((s) => s.tasks)
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])

  const { previewVersion, chooseVersion, retryVersion } = useBgSwapStore.getState()
  const versions = selected?.versions ?? []

  return (
    <div>
      <span className={LABEL}>版本</span>
      {versions.length === 0 ? (
        <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">暂无版本</p>
      ) : (
        <ul data-bgswap-versions className="mt-1.5 flex flex-col gap-1.5">
          {versions.map((version, index) => {
            const progress = versionProgress(tasksById.get(version.taskId))
            const chosen = selected?.chosenVersionId === version.id
            const badge = matteBadge(version)
            return (
              <li
                key={version.id}
                data-bgswap-version
                className={`rounded-xl border p-2 transition ${
                  previewVersionId === version.id
                    ? 'border-blue-400 bg-blue-500/5 dark:border-blue-500/50'
                    : 'border-gray-200 dark:border-white/[0.08]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => previewVersion(version.id)}
                  aria-pressed={previewVersionId === version.id}
                  className="block w-full text-left"
                >
                  <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                    <span className="font-medium text-gray-700 dark:text-gray-200">
                      第 {index + 1} 版
                    </span>
                    {progress.state === 'running' ? (
                      <Pending label="生成中" startedAt={progress.startedAt} />
                    ) : (
                      <span>
                        {VERSION_STATE_LABELS[progress.state]}
                        {progress.elapsed === null ? '' : ` ${formatElapsed(progress.elapsed)}`}
                      </span>
                    )}
                    {badge && (
                      <span className={`rounded px-1.5 py-0.5 ${BADGE_TONE[badge.tone]}`}>
                        {badge.text}
                      </span>
                    )}
                    {chosen && (
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-700 dark:text-blue-300">
                        已选
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-gray-600 dark:text-gray-300">
                    {version.plan}
                  </span>
                </button>

                {progress.error && <p className={`mt-1.5 ${NOTICE}`}>{progress.error}</p>}

                <div className="mt-1.5 flex gap-1">
                  {progress.state === 'error' && (
                    <button
                      type="button"
                      onClick={() => void retryVersion(version.id)}
                      className={ACTION}
                    >
                      重跑
                    </button>
                  )}
                  {progress.state === 'done' && !chosen && (
                    <button
                      type="button"
                      onClick={() => chooseVersion(version.id)}
                      className={ACTION}
                    >
                      用这版
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
