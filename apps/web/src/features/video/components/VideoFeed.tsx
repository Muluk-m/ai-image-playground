import { useEffect, useMemo, useState } from 'react'
import { CARD, FIELD } from '../../../components/panelStyles'
import { ALL_FILTER, filterVideoTasks, videoFeedFilters } from '../lib/feed'
import { useVideoStore } from '../store'
import { ACTIVE_CHIP, CHIP, IDLE_CHIP } from './chipStyles'
import VideoCard from './VideoCard'
import VideoLightbox from './VideoLightbox'

export default function VideoFeed() {
  const tasks = useVideoStore((s) => s.tasks)
  const [query, setQuery] = useState('')
  const [filterId, setFilterId] = useState(ALL_FILTER)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  const filters = useMemo(() => videoFeedFilters(tasks), [tasks])
  const visible = useMemo(() => filterVideoTasks(tasks, filterId, query), [tasks, filterId, query])
  const openTask = tasks.find((task) => task.id === openTaskId) ?? null

  // 选中的筛选可能随最后一条任务消失（删完、或都跑完了）。
  useEffect(() => {
    if (!filters.some((filter) => filter.id === filterId)) setFilterId(ALL_FILTER)
  }, [filters, filterId])

  return (
    <section className={`${CARD} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索描述"
          placeholder="搜索描述"
          className={`${FIELD} w-full max-w-xs`}
        />
        <div role="group" aria-label="结果筛选" className="flex flex-wrap gap-1.5">
          {filters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={filter.id === filterId}
              onClick={() => setFilterId(filter.id)}
              className={`${CHIP} ${filter.id === filterId ? ACTIVE_CHIP : IDLE_CHIP}`}
            >
              {filter.label} {filter.count}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {tasks.length === 0 ? '还没有生成过视频' : '没有匹配的结果'}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {visible.map((task) => (
            <VideoCard key={task.id} task={task} onOpen={() => setOpenTaskId(task.id)} />
          ))}
        </ul>
      )}

      {openTask && <VideoLightbox task={openTask} onClose={() => setOpenTaskId(null)} />}
    </section>
  )
}
