import {
  type KeyboardEvent,
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useAuth } from '../../../auth/AuthContext'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import EmptyState from '../../../components/patterns/EmptyState'
import SegmentedTabs from '../../../components/patterns/SegmentedTabs'
import TaskBulkActions from '../../../components/TaskBulkActions'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useCloudGenerations } from '../../../hooks/useCloudGenerations'
import {
  DragSelectionRect,
  type SelectableCardRect,
  useDragSelection,
} from '../../../hooks/useDragSelection'
import { useHistoryTasks } from '../../../hooks/useHistoryTasks'
import { useImagePreview } from '../../../hooks/useImagePreview'
import { useNearEnd } from '../../../hooks/useNearEnd'
import { useWindowVirtualizer } from '../../../hooks/useWindowVirtualizer'
import { useTranslation } from '../../../i18n'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { isHistoryReady, subscribeHistoryReady } from '../../../lib/historyReady'
import { cn } from '../../../lib/utils'
import {
  matchesWorksFilter,
  type WorksFilter,
  workProjectId,
  workRatio,
  workSource,
  worksCounts,
} from '../../../lib/works'
import { reuseConfig, useStore } from '../../../store'
import type { TaskRecord } from '../../../types'
import { columnsForWidth, MASONRY_GAP, MASONRY_GAP_COMPACT } from '../../inspiration/lib/masonry'
import { openWorkProject } from '../lib/openWorkProject'

const FILTERS: readonly WorksFilter[] = ['all', 'studio', 'agent']
const FILTER_LABEL = {
  all: 'works.all',
  studio: 'works.studio',
  agent: 'works.agent',
} as const satisfies Record<WorksFilter, string>
const SKELETON_RATIOS = [1.33, 1, 1.5, 0.75, 1.25, 1, 1.4, 0.8, 1.2, 1.33, 0.9, 1.1]

function useCompact(): boolean {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia('(max-width: 767px)')
    const apply = () => setCompact(list.matches)
    apply()
    list.addEventListener('change', apply)
    return () => list.removeEventListener('change', apply)
  }, [])
  return compact
}

function matchesSearch(task: TaskRecord, query: string): boolean {
  if (!query) return true
  return task.prompt.toLowerCase().includes(query)
}

/**
 * 「资产 → 作品」：快速生成与对话产出的所有图，一条按时间倒序的瀑布。
 * 数据与创作页作品同源（本机任务 + 平台记录），平台记录按游标 50 条一页往后读，
 * 离底部 240px 就读下一页；卡片按窗口虚拟化，只挂视口附近的。
 */
export default function WorksTab({ search }: { search: string }) {
  const { t } = useTranslation('library')
  const userId = useAuth().user?.id
  const cloud = useCloudGenerations(Boolean(userId) && isClientCapabilityEnabled('accounts:sync'))
  const tasks = useHistoryTasks()
  const rows = useStore((s) => s.platformGenerations)
  const historyReady = useSyncExternalStore(subscribeHistoryReady, isHistoryReady, () => false)
  const [filter, setFilter] = useState<WorksFilter>('all')
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const query = search.trim().toLowerCase()

  const ordered = useMemo(() => [...tasks].sort((a, b) => b.createdAt - a.createdAt), [tasks])
  const visible = useMemo(
    () =>
      ordered.filter(
        (task) =>
          matchesWorksFilter(workSource(task, rowsById), filter) && matchesSearch(task, query),
      ),
    [ordered, rowsById, filter, query],
  )
  // 搜索时只数读下来的；否则按服务端总数，加减本机新出的与刚删的。
  const counts = useMemo(
    () => worksCounts(ordered, rowsById, query ? null : cloud.snapshot),
    [ordered, rowsById, query, cloud.snapshot],
  )
  const visibleIds = useMemo(() => visible.map((task) => task.id), [visible])

  // 离开作品页签时清掉选中，免得回到创作页还挂着这里的批量操作条。
  useEffect(() => () => useStore.getState().clearSelection(), [])

  const loading = !historyReady || (cloud.loading && ordered.length === 0)
  return (
    <div data-drag-select-surface className="flex min-h-0 flex-1 flex-col px-4 pb-32 pt-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedTabs
          tabs={FILTERS.map((one) => ({
            value: one,
            label: `${t(FILTER_LABEL[one])} ${counts[one]}`,
          }))}
          value={filter}
          onChange={setFilter}
          label={t('works.filterAria')}
        />
        {cloud.failed && (
          <Button type="button" variant="outline" size="sm" onClick={cloud.reload}>
            <Icon name="refresh" />
            {t('works.retry')}
          </Button>
        )}
      </div>
      {loading ? (
        <WorksSkeleton />
      ) : visible.length > 0 ? (
        <WorksGrid
          tasks={visible}
          rowsById={rowsById}
          hasMore={cloud.hasMore && !cloud.failed}
          loading={cloud.loading}
          onLoadMore={cloud.loadMore}
        />
      ) : cloud.hasMore && !cloud.failed ? (
        // 筛到的还没读到：继续往后读，直到有一张或读完。
        <LoadMoreSentinel loading={cloud.loading} onLoadMore={cloud.loadMore} />
      ) : (
        <EmptyState title={t(query ? 'works.noMatch' : 'works.empty')} />
      )}
      <TaskBulkActions visibleTaskIds={visibleIds} placement="page" />
    </div>
  )
}

function LoadMoreSentinel({ loading, onLoadMore }: { loading: boolean; onLoadMore: () => void }) {
  const ref = useNearEnd<HTMLDivElement>(onLoadMore, !loading)
  return (
    <div ref={ref} className="flex justify-center py-10" aria-hidden="true">
      {loading && <Icon name="loading" className="animate-spin text-muted-foreground" />}
    </div>
  )
}

function WorksSkeleton() {
  return (
    <div
      data-testid="works-skeleton"
      className="grid grid-cols-2 items-start gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 md:gap-3"
    >
      {SKELETON_RATIOS.map((ratio, index) => (
        <div
          key={index}
          className="animate-pulse rounded-xl bg-muted"
          style={{ aspectRatio: `1 / ${ratio}` }}
        />
      ))}
    </div>
  )
}

interface GridProps {
  tasks: readonly TaskRecord[]
  rowsById: Parameters<typeof workSource>[1]
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
}

function WorksGrid({ tasks, rowsById, hasMore, loading, onLoadMore }: GridProps) {
  const compact = useCompact()
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [scrollMargin, setScrollMargin] = useState(0)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const selected = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds])

  useLayoutEffect(() => {
    if (!node) return
    const measure = () => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  useLayoutEffect(() => {
    if (!node) return
    const top = Math.round(node.getBoundingClientRect().top + window.scrollY)
    setScrollMargin((current) => (Math.abs(top - current) > 1 ? top : current))
  })

  const gap = compact ? MASONRY_GAP_COMPACT : MASONRY_GAP
  const columns = width > 0 ? columnsForWidth(width) : 2
  const columnWidth = width > 0 ? Math.max(0, (width - gap * (columns - 1)) / columns) : 0
  // 卡片只有图，高度由已知比例算出，不必挂上去再量：滚动时不会因为图加载而跳。
  const estimateSize = useCallback(
    (index: number) => {
      const task = tasks[index]
      return task && columnWidth > 0 ? Math.round(columnWidth * workRatio(task)) : 240
    },
    [tasks, columnWidth],
  )
  const getItemKey = useCallback((index: number) => tasks[index]?.id ?? index, [tasks])
  const virtualizer = useWindowVirtualizer({
    count: columnWidth > 0 ? tasks.length : 0,
    estimateSize,
    gap,
    lanes: columns,
    overscan: columns * 2,
    scrollMargin,
    getItemKey,
  })

  // 列宽变了，每张卡的高度都跟着变；虚拟器只在这里重新排。
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [virtualizer, columnWidth, columns, tasks])

  // 框选按布局算位置：滚出视口没挂载的卡也能被框进来。
  const cardRects = useRef<() => SelectableCardRect[]>(() => [])
  cardRects.current = () => {
    if (!node) return []
    const left = node.getBoundingClientRect().left + window.scrollX
    return virtualizer.measurementsCache.map((item) => {
      const x = left + item.lane * (columnWidth + gap)
      return {
        taskId: String(item.key),
        left: x,
        right: x + columnWidth,
        top: item.start,
        bottom: item.end,
      }
    })
  }
  const { selectionBox, openCard } = useDragSelection(cardRects)
  const endRef = useNearEnd<HTMLDivElement>(onLoadMore, hasMore && !loading)

  return (
    <>
      <div
        ref={setNode}
        data-testid="works-grid"
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {columnWidth > 0 &&
          virtualizer.getVirtualItems().map((item) => {
            const task = tasks[item.index]
            if (!task) return null
            return (
              <WorkTile
                key={task.id}
                task={task}
                projectId={workProjectId(task, rowsById)}
                selected={selected.has(task.id)}
                onOpen={openCard}
                style={{
                  left: item.lane * (columnWidth + gap),
                  width: columnWidth,
                  height: item.size,
                  transform: `translateY(${item.start - scrollMargin}px)`,
                }}
              />
            )
          })}
      </div>
      {hasMore && (
        <div ref={endRef} className="flex justify-center py-8" aria-hidden="true">
          {loading && <Icon name="loading" className="animate-spin text-muted-foreground" />}
        </div>
      )}
      <DragSelectionRect box={selectionBox} />
    </>
  )
}

interface TileProps {
  task: TaskRecord
  projectId: string | null
  selected: boolean
  onOpen: (taskId: string, event: ReactMouseEvent) => void
  style: React.CSSProperties
}

const WorkTile = memo(function WorkTile({ task, projectId, selected, onOpen, style }: TileProps) {
  const { t } = useTranslation('library')
  const preview = useImagePreview(task.status === 'done' ? task.outputImages?.[0] : undefined)
  const open = (event: ReactMouseEvent) => onOpen(task.id, event)
  const onKeyDown = (event: KeyboardEvent) => {
    // 卡里的按钮自己处理回车和空格；冒泡上来的不能被卡片截走。
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    useStore.getState().setDetailTaskId(task.id)
  }
  return (
    <div
      data-selectable-card
      data-task-id={task.id}
      data-testid="work-card"
      role="button"
      tabIndex={0}
      aria-label={task.prompt || t('works.untitled')}
      aria-pressed={selected || undefined}
      onClick={open}
      onKeyDown={onKeyDown}
      className={cn(
        'group absolute left-0 top-0 cursor-pointer overflow-hidden rounded-xl bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
      )}
      style={style}
    >
      {preview ? (
        <img
          src={preview.url}
          data-image-id={task.outputImages[0]}
          className="saveable-image size-full object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
          alt=""
        />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          {task.status === 'running' ? (
            <Icon name="loading" size="lg" className="animate-spin text-primary" />
          ) : task.status === 'error' ? (
            <Icon
              name="error"
              size="lg"
              className={task.cancelled ? undefined : 'text-destructive'}
            />
          ) : (
            <Icon name="image" size="lg" />
          )}
        </div>
      )}
      {task.outputImages.length > 1 && (
        <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
          {task.outputImages.length}
        </span>
      )}
      {selected && (
        <span className="absolute left-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Icon name="check" size="xs" />
        </span>
      )}
      {task.status === 'done' && (
        <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/50 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <TooltipIconButton
            tooltip={t('works.continue')}
            side="top"
            className="bg-black/40 text-white hover:bg-black/60 hover:text-white"
            onClick={(event) => {
              event.stopPropagation()
              void reuseConfig(task)
            }}
          >
            <Icon name="reuse" />
          </TooltipIconButton>
          {projectId && (
            <TooltipIconButton
              tooltip={t('works.openProject')}
              side="top"
              className="bg-black/40 text-white hover:bg-black/60 hover:text-white"
              onClick={(event) => {
                event.stopPropagation()
                void openWorkProject(projectId)
              }}
            >
              <Icon name="chat" />
            </TooltipIconButton>
          )}
        </div>
      )}
    </div>
  )
})
