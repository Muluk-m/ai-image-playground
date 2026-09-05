import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useBgSwapStore } from '../store'
import BgSwapBatchBar from './BgSwapBatchBar'
import BgSwapControls from './BgSwapControls'
import BgSwapGallery from './BgSwapGallery'
import BgSwapPreview from './BgSwapPreview'
import BgSwapSources from './BgSwapSources'

export default function BgSwapMode() {
  const jobs = useBgSwapStore(useShallow((s) => s.jobs))
  const activeJobId = useBgSwapStore((s) => s.activeJobId)
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

      <BgSwapBatchBar />
      <BgSwapGallery />
    </main>
  )
}
