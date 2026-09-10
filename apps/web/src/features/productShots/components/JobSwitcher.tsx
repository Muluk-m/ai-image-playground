import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDownIcon, EditIcon, PlusIcon, TrashIcon } from '../../../components/icons'
import { FIELD, LABEL, OUTLINE_BUTTON } from '../../../components/panelStyles'
import { useStore } from '../../../store'
import { byRecency, useProductShotsStore } from '../store'
import type { ProductShotJob } from '../types'
import IconButton from './IconButton'

const UNSAVED = '新任务'

function versionCount(job: ProductShotJob): number {
  return job.images.reduce((total, image) => total + image.versions.length, 0)
}

export default function JobSwitcher() {
  const jobs = useProductShotsStore(useShallow((s) => s.jobs))
  const activeJobId = useProductShotsStore((s) => s.activeJobId)
  const name = useProductShotsStore((s) => s.draft.name)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draftName, setDraftName] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const { selectJob, startNewJob, renameJob, deleteJob } = useProductShotsStore.getState()

  const closeList = () => {
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeList()
    }
    document.addEventListener('mousedown', closeOnOutside)
    return () => document.removeEventListener('mousedown', closeOnOutside)
  }, [open])

  const listed = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return jobs.filter((job) => job.name.toLowerCase().includes(keyword)).sort(byRecency)
  }, [jobs, query])

  const beginRename = () => {
    if (!activeJobId) return
    closeList()
    setDraftName(name)
  }

  const commitRename = () => {
    if (draftName !== null && activeJobId) void renameJob(activeJobId, draftName)
    setDraftName(null)
  }

  const openFresh = () => {
    closeList()
    startNewJob()
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className={LABEL}>任务</span>

      <div ref={rootRef} className="relative w-full sm:w-72">
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-1 dark:border-white/[0.12] dark:bg-white/[0.04]">
          {draftName === null ? (
            <button
              type="button"
              data-job-switcher-trigger
              onClick={() => (open ? closeList() : setOpen(true))}
              onDoubleClick={beginRename}
              aria-expanded={open}
              aria-haspopup="true"
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-gray-800 dark:text-gray-100"
            >
              <span data-job-name title={name || UNSAVED} className="min-w-0 flex-1 truncate">
                {name || UNSAVED}
              </span>
              <ChevronDownIcon
                className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform dark:text-gray-500 ${open ? 'rotate-180' : ''}`}
              />
            </button>
          ) : (
            <input
              autoFocus
              aria-label="任务名"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename()
                if (event.key === 'Escape') setDraftName(null)
              }}
              maxLength={60}
              className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1.5 text-sm text-gray-800 focus:outline-none dark:text-gray-100"
            />
          )}

          {draftName === null && activeJobId && (
            <IconButton
              onClick={beginRename}
              label="重命名任务"
              className="shrink-0 rounded-md p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            >
              <EditIcon className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>

        {open && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-gray-200/60 bg-white/95 shadow-[0_8px_30px_rgb(0,0,0,0.12)] backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)]">
            <div className="p-2">
              <input
                aria-label="搜索任务"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索任务"
                className={FIELD}
              />
            </div>

            <ul className="custom-scrollbar max-h-64 overflow-y-auto">
              {listed.length === 0 && (
                <li className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
                  没有匹配的任务
                </li>
              )}
              {listed.map((job) => (
                <li
                  key={job.id}
                  className={`flex items-center gap-1 px-2 ${
                    job.id === activeJobId ? 'bg-blue-50 dark:bg-blue-500/10' : ''
                  }`}
                >
                  <button
                    type="button"
                    data-job-option
                    data-job-id={job.id}
                    aria-current={job.id === activeJobId}
                    onClick={() => {
                      selectJob(job.id)
                      closeList()
                    }}
                    className="min-w-0 flex-1 rounded-lg px-1 py-2 text-left transition hover:bg-gray-50 dark:hover:bg-white/[0.06]"
                  >
                    <span
                      data-job-option-name
                      title={job.name}
                      className="block truncate text-sm text-gray-800 dark:text-gray-100"
                    >
                      {job.name}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">
                      {new Date(job.createdAt).toLocaleDateString('zh-CN')} · {job.images.length} 图
                      · {versionCount(job)} 版
                    </span>
                  </button>
                  <IconButton
                    label={`删除任务 ${job.name}`}
                    onClick={() => {
                      closeList()
                      setConfirmDialog({
                        title: '删除任务',
                        message: `确定删除任务「${job.name}」吗？图片与已生成的历史保留。`,
                        tone: 'danger',
                        action: () => void deleteJob(job.id),
                      })
                    }}
                    className="shrink-0 rounded-md p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={openFresh}
              className="flex w-full items-center gap-1.5 border-t border-gray-200/70 px-3 py-2 text-sm font-medium text-blue-600 transition hover:bg-blue-50 dark:border-white/[0.08] dark:text-blue-300 dark:hover:bg-blue-500/10"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              新建任务
            </button>
          </div>
        )}
      </div>

      <button type="button" data-job-new onClick={openFresh} className={OUTLINE_BUTTON}>
        新建任务
      </button>
    </div>
  )
}
