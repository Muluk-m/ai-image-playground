import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CARD, PRIMARY_BUTTON } from '../../../components/panelStyles'
import { useBgSwapStore } from '../store'
import BgSwapControls from './BgSwapControls'
import BgSwapPreview from './BgSwapPreview'
import BgSwapSources from './BgSwapSources'

export default function BgSwapMode() {
  const jobs = useBgSwapStore(useShallow((s) => s.jobs))
  const activeJobId = useBgSwapStore((s) => s.activeJobId)
  const imageCount = useBgSwapStore((s) => s.draft.images.length)
  const selectJob = useBgSwapStore((s) => s.selectJob)
  const startNewJob = useBgSwapStore((s) => s.startNewJob)

  useEffect(() => {
    void useBgSwapStore.getState().loadJobs()
  }, [])

  return (
    <main className="safe-area-x mx-auto max-w-7xl px-4 pb-24 pt-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">任务</span>
        {jobs.map((job) => (
          <button
            key={job.id}
            type="button"
            onClick={() => selectJob(job.id)}
            aria-pressed={activeJobId === job.id}
            className={`max-w-48 truncate rounded-lg px-3 py-1.5 text-sm transition ${
              activeJobId === job.id
                ? 'bg-blue-500/10 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'
            }`}
          >
            {job.name}
          </button>
        ))}
        <button
          type="button"
          onClick={startNewJob}
          className="rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.12] dark:text-gray-300 dark:hover:border-blue-500/50 dark:hover:text-blue-300"
        >
          新建任务
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_17rem]">
        <BgSwapSources />
        <BgSwapPreview />
        <BgSwapControls />
      </div>

      {/* 批量与总览在 #110 落地，「每张几版」也在那里才生效，本票只占位。 */}
      <div className={`${CARD} mt-4 flex flex-wrap items-center justify-between gap-3`}>
        <p className="text-sm text-gray-700 dark:text-gray-200">
          对剩下的 {Math.max(0, imageCount - 1)} 张全部按同样方式跑
        </p>
        <button type="button" disabled className={PRIMARY_BUTTON}>
          批量跑
        </button>
      </div>

      <section className={`${CARD} mt-4`}>
        <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">结果总览</h2>
        <p className="text-xs text-gray-400 dark:text-gray-500">暂无结果</p>
      </section>
    </main>
  )
}
