import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import InspirationEmptyHero from '../features/inspiration/components/InspirationEmptyHero'
import { useHistoryTasks } from '../hooks/useHistoryTasks'
import { useWindowVirtualizer } from '../hooks/useWindowVirtualizer'
import { i18next, useTranslation } from '../i18n'
import { isHistoryReady, subscribeHistoryReady } from '../lib/historyReady'
import {
  type LegacyProductJob,
  legacyActionLabels,
  readLegacyProductJobs,
  readLegacyStoryboardTitles,
} from '../lib/legacyProductHistory'
import { groupTasksBySet } from '../lib/setHistory'
import {
  revealSubmittedCard,
  submittedTaskServerSnapshot,
  submittedTaskSnapshot,
  subscribeSubmittedTasks,
} from '../lib/submittedTaskAttention'
import { editOutputImage, removeTask, reuseConfig, sendTaskToCanvas, useStore } from '../store'
import type { TaskRecord } from '../types'
import SetHistoryCard from './SetHistoryCard'
import TaskCard from './TaskCard'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

/** 网格列数与 `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` 的断点保持一致。 */
const COLUMN_QUERIES = [
  ['(min-width: 1024px)', 3],
  ['(min-width: 640px)', 2],
] as const
const GRID_GAP = 16
/** 一行卡片的预估高度；实际高度渲染后按行测量。 */
const ESTIMATED_ROW_HEIGHT = 420

function currentColumns(): number {
  if (typeof window === 'undefined' || !window.matchMedia) return 1
  return COLUMN_QUERIES.find(([query]) => window.matchMedia(query).matches)?.[1] ?? 1
}

function useGridColumns(): number {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const lists = COLUMN_QUERIES.map(([query]) => window.matchMedia(query))
      for (const list of lists) list.addEventListener('change', listener)
      return () => {
        for (const list of lists) list.removeEventListener('change', listener)
      }
    },
    currentColumns,
    () => 1,
  )
}

interface GridItem {
  readonly key: string
  readonly taskId?: string
  readonly node: ReactNode
}

interface CardRect {
  readonly taskId: string
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

interface TaskHandlers {
  open(task: TaskRecord, event: ReactMouseEvent | ReactTouchEvent): void
  reuse(task: TaskRecord): void
  edit(task: TaskRecord): void
  send(task: TaskRecord): void
  remove(task: TaskRecord): void
}

/** 一张作品卡。任务、选中态与处理函数都不变时跳过渲染：轮询更新一条任务不再重画整个网格。 */
const TaskGridItem = memo(function TaskGridItem({
  task,
  attended,
  selected,
  handlers,
}: {
  task: TaskRecord
  attended: boolean
  selected: boolean
  handlers: TaskHandlers
}) {
  return (
    <div
      className={attended ? 'task-card-wrapper task-submitted-attention' : 'task-card-wrapper'}
      data-task-id={task.id}
      tabIndex={attended ? -1 : undefined}
    >
      <TaskCard
        task={task}
        onClick={(event) => handlers.open(task, event)}
        onReuse={() => handlers.reuse(task)}
        onEditOutputs={() => handlers.edit(task)}
        onSendToCanvas={() => handlers.send(task)}
        onDelete={() => handlers.remove(task)}
        isSelected={selected}
      />
    </div>
  )
})

/** 首页作品区在本机记录落地前的占位。侧栏、标题和输入框已经是真的，这里只盖网格。 */
function HomeWorksSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 pb-6 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index}>
          <div className="aspect-[4/3] animate-pulse rounded-2xl bg-muted" />
          <div className="mt-3 h-3 w-2/5 animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  )
}

/** 套的名字要落在它自己的记录上；记录还没加载时至少不能把分镜说成商品图。 */
function setFallbackName(task: TaskRecord | undefined): string {
  return task?.origin?.kind === 'storyboard'
    ? i18next.t('set.storyboardFallback', { ns: 'task' })
    : i18next.t('set.productShotFallback', { ns: 'task' })
}

/**
 * 生成记录的网格。只有一种卡：只在平台留有记录的生成先被镜像成本机任务记录（见 `lib/cloudMirror`），
 * 再和本机生成一起按时间倒序排进同一个网格。像素存在哪儿不该从卡片上看出来。
 *
 * 给了 `limit` 就是生图入口的「最近生成」：只摆最近几条，且不受作品入口留下的搜索与筛选影响——
 * 那一页没有清除它们的入口。
 */
export default function TaskGrid({
  limit,
  hero,
  hasMore = false,
  onExpand,
}: {
  limit?: number
  hero?: boolean
  hasMore?: boolean
  onExpand?: () => void
} = {}) {
  const { t } = useTranslation('task')
  const historyReady = useSyncExternalStore(subscribeHistoryReady, isHistoryReady, () => false)
  const submittedIds = useSyncExternalStore(
    subscribeSubmittedTasks,
    submittedTaskSnapshot,
    submittedTaskServerSnapshot,
  )
  const [submittedAnnouncement, setSubmittedAnnouncement] = useState('')
  const revealedSubmittedIds = useRef(new Set<string>())
  const submittedAnnouncementRef = useRef('')
  const tasks = useHistoryTasks()
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const cardRects = useRef<() => CardRect[]>(() => [])
  const [selectionBox, setSelectionBox] = useState<{
    startPageX: number
    startPageY: number
    currentPageX: number
    currentPageY: number
  } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const dragScrollDirectionRef = useRef<-1 | 1 | null>(null)
  const lastToastTimeRef = useRef(0)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  const [expandedSetIds, setExpandedSetIds] = useState<string[]>([])

  const unfiltered = limit !== undefined
  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    if (unfiltered) return sorted
    const q = searchQuery.trim().toLowerCase()

    return sorted.filter((t) => {
      if (filterFavorite && !t.isFavorite) return false
      const matchStatus = filterStatus === 'all' || t.status === filterStatus
      if (!matchStatus) return false

      if (!q) return true
      const prompt = (t.prompt || '').toLowerCase()
      const paramStr = JSON.stringify(t.params).toLowerCase()
      return prompt.includes(q) || paramStr.includes(q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite, unfiltered])

  const historyItems = useMemo(() => groupTasksBySet(filteredTasks), [filteredTasks])

  const [productShotJobs, setProductShotJobs] = useState<LegacyProductJob[]>([])
  const [storyboardTitles, setStoryboardTitles] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let active = true
    void readLegacyProductJobs()
      .then((jobs) => {
        if (active) setProductShotJobs(jobs)
      })
      .catch((error) => console.warn('[history] Legacy records unavailable', error))
    void readLegacyStoryboardTitles()
      .then((titles) => {
        if (active) setStoryboardTitles(titles)
      })
      .catch((error) => console.warn('[history] Legacy storyboards unavailable', error))
    return () => {
      active = false
    }
  }, [])

  const handleDelete = (task: (typeof tasks)[0]) => {
    setConfirmDialog({
      title: t('action.deleteRecord'),
      message: t('confirm.deleteMessage'),
      action: () => removeTask(task),
    })
  }

  const getPagePoint = (clientX: number, clientY: number) => ({
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
  })

  const beginSelection = (
    target: HTMLElement,
    clientX: number,
    clientY: number,
    isCtrl: boolean,
  ) => {
    const point = getPagePoint(clientX, clientY)

    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = point
    lastClientPoint.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startPageX: point.pageX,
      startPageY: point.pageY,
      currentPageX: point.pageX,
      currentPageY: point.pageY,
    })
  }

  const updateSelectionFromPoint = (pageX: number, pageY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.pageX, pageX)
    const maxX = Math.max(start.pageX, pageX)
    const minY = Math.min(start.pageY, pageY)
    const maxY = Math.max(start.pageY, pageY)

    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    for (const card of cardRects.current()) {
      const isIntersecting =
        minX < card.right && maxX > card.left && minY < card.bottom && maxY > card.top

      if (isIntersecting) {
        if (initialSelected.has(card.taskId)) {
          newSelected.delete(card.taskId)
        } else {
          newSelected.add(card.taskId)
        }
      } else if (!initialSelected.has(card.taskId)) {
        newSelected.delete(card.taskId)
      }
    }

    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    const stopDragScroll = () => {
      if (dragScrollIntervalRef.current) {
        clearInterval(dragScrollIntervalRef.current)
        dragScrollIntervalRef.current = null
      }
      dragScrollDirectionRef.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return
      stopDragScroll()
      dragScrollDirectionRef.current = direction
      dragScrollIntervalRef.current = window.setInterval(() => {
        window.scrollBy({ top: direction * 15, behavior: 'instant' })
      }, 16)
    }

    const endSelection = (clearEmptySurfaceClick = false, suppressClick = false) => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (
        isDragging.current &&
        clearEmptySurfaceClick &&
        !hasDragged.current &&
        !startedOnCard.current &&
        !startedWithCtrl.current
      ) {
        clearSelection()
      }
      if (isDragging.current && suppressClick && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      stopDragScroll()
      isDragging.current = false
      dragStart.current = null
      lastClientPoint.current = null
      setSelectionBox(null)
    }

    const getEventElement = (e: MouseEvent) => {
      if (e.target instanceof Element) return e.target
      return document.elementFromPoint(e.clientX, e.clientY)
    }

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target as HTMLElement, e.clientX, e.clientY, isCtrl)
      e.preventDefault()
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
      e.preventDefault()

      const scrollThreshold = 40
      if (e.clientY < scrollThreshold) {
        startDragScroll(-1)
      } else if (e.clientY > window.innerHeight - scrollThreshold) {
        startDragScroll(1)
      } else {
        stopDragScroll()
      }
    }

    const handleDocumentScroll = () => {
      if (
        !isDragging.current ||
        !dragStart.current ||
        !lastClientPoint.current ||
        !hasDragged.current
      )
        return

      const point = getPagePoint(lastClientPoint.current.x, lastClientPoint.current.y)
      const start = dragStart.current
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const handleDocumentWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return

      e.preventDefault()
      const now = Date.now()
      if (now - lastToastTimeRef.current > 3000) {
        lastToastTimeRef.current = now
        const keyName = isMac ? '⌘' : 'Ctrl'
        useStore
          .getState()
          .showToast(i18next.t('grid.releaseKeyHint', { ns: 'task', key: keyName }), 'info')
      }
    }

    const handleDocumentMouseUp = () => {
      endSelection(true, true)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    document.addEventListener('mousemove', handleDocumentMouseMove, true)
    document.addEventListener('mouseup', handleDocumentMouseUp, true)
    document.addEventListener('wheel', handleDocumentWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleDocumentScroll, true)
    return () => {
      stopDragScroll()
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
      document.removeEventListener('mousemove', handleDocumentMouseMove, true)
      document.removeEventListener('mouseup', handleDocumentMouseUp, true)
      document.removeEventListener('wheel', handleDocumentWheel, true)
      window.removeEventListener('scroll', handleDocumentScroll, true)
    }
  }, [clearSelection, isMac])

  // 卡片拿到的处理函数保持同一引用，里面再读最新的状态，作品卡才能跳过无关的重渲染。
  const latest = useRef<TaskHandlers>(null!)
  latest.current = {
    open: (task, e) => {
      if (Date.now() < suppressClickUntil.current) {
        e.preventDefault()
        return
      }
      suppressClickUntil.current = 0
      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      if (isCtrl) {
        useStore.getState().toggleTaskSelection(task.id)
      } else if (useStore.getState().selectedTaskIds.length > 0) {
        clearSelection()
        setDetailTaskId(task.id)
      } else {
        setDetailTaskId(task.id)
      }
    },
    reuse: (task) => reuseConfig(task),
    edit: (task) => editOutputImage(task),
    send: (task) => sendTaskToCanvas(task),
    remove: (task) => handleDelete(task),
  }
  const handlers = useMemo<TaskHandlers>(
    () => ({
      open: (task, event) => latest.current.open(task, event),
      reuse: (task) => latest.current.reuse(task),
      edit: (task) => latest.current.edit(task),
      send: (task) => latest.current.send(task),
      remove: (task) => latest.current.remove(task),
    }),
    [],
  )
  const selectedSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds])
  const renderTask = (task: (typeof tasks)[0]): GridItem => ({
    key: task.id,
    taskId: task.id,
    node: (
      <TaskGridItem
        key={task.id}
        task={task}
        attended={submittedIds.includes(task.id)}
        selected={selectedSet.has(task.id)}
        handlers={handlers}
      />
    ),
  })

  // 两边的卡按同一条时间轴排；套折成一条，落在它最新那条任务的位置上。
  const rows: { at: number; nodes: GridItem[] }[] = historyItems.map((item) => {
    if (item.kind === 'task') return { at: item.task.createdAt, nodes: [renderTask(item.task)] }
    const expanded = expandedSetIds.includes(item.setId)
    const title = storyboardTitles.get(item.setId)
    const job = title ? undefined : productShotJobs.find((e) => e.id === item.setId)
    return {
      at: item.tasks.reduce(
        (latest, task) => Math.max(latest, task.createdAt),
        Number.NEGATIVE_INFINITY,
      ),
      nodes: [
        {
          key: `set-${item.setId}`,
          node: (
            <SetHistoryCard
              key={`set-${item.setId}`}
              name={title ?? job?.name ?? setFallbackName(item.tasks[0])}
              actions={legacyActionLabels(job)}
              tasks={item.tasks}
              expanded={expanded}
              onToggle={() =>
                setExpandedSetIds((ids) =>
                  ids.includes(item.setId)
                    ? ids.filter((id) => id !== item.setId)
                    : [...ids, item.setId],
                )
              }
            />
          ),
        },
        ...(expanded ? item.tasks.map(renderTask) : []),
      ],
    }
  })

  rows.sort((a, b) => b.at - a.at)
  const visibleRows = limit === undefined ? rows : rows.slice(0, limit)
  const items = visibleRows.flatMap((row) => row.nodes)

  // 展开后的作品一次全挂上会随数量线性变卡：按当前列数分行，只渲染视口附近的几行。
  const virtual = limit === undefined
  const columns = useGridColumns()
  const itemRows = useMemo(() => {
    const chunks: GridItem[][] = []
    for (let index = 0; index < items.length; index += columns)
      chunks.push(items.slice(index, index + columns))
    return chunks
  }, [items, columns])
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualizer = useWindowVirtualizer({
    count: virtual ? itemRows.length : 0,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    gap: GRID_GAP,
    overscan: 2,
    scrollMargin,
    getItemKey: (index) => itemRows[index]?.map((item) => item.key).join('|') ?? index,
  })
  // 网格上方的标题、搜索栏高度会变，列表起点要跟着它走。
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!virtual || !grid) return
    const top = Math.round(grid.getBoundingClientRect().top + window.scrollY)
    if (Math.abs(top - scrollMargin) > 1) setScrollMargin(top)
  })
  // 框选按布局算卡片位置：滚出视口而未挂载的卡也照样参与选择。
  cardRects.current = () => {
    const grid = gridRef.current
    if (!grid) return []
    if (!virtual) {
      return [...grid.querySelectorAll<HTMLElement>('.task-card-wrapper')].flatMap((card) => {
        const taskId = card.dataset.taskId
        if (!taskId) return []
        const rect = card.getBoundingClientRect()
        return [
          {
            taskId,
            left: rect.left + window.scrollX,
            right: rect.right + window.scrollX,
            top: rect.top + window.scrollY,
            bottom: rect.bottom + window.scrollY,
          },
        ]
      })
    }
    const bounds = grid.getBoundingClientRect()
    const left = bounds.left + window.scrollX
    const width = (bounds.width - GRID_GAP * (columns - 1)) / columns
    const measured = virtualizer.measurementsCache
    return itemRows.flatMap((row, rowIndex) => {
      const position = measured[rowIndex]
      if (!position) return []
      return row.flatMap((item, column) =>
        item.taskId
          ? [
              {
                taskId: item.taskId,
                left: left + column * (width + GRID_GAP),
                right: left + column * (width + GRID_GAP) + width,
                top: position.start,
                bottom: position.end,
              },
            ]
          : [],
      )
    })
  }

  const firstRow = virtualizer.range?.startIndex
  // 只有这次主动发送记下来的任务才滚、高亮、抢焦点。恢复和轮询会改 tasks，但 id 不在这份名单里。
  useLayoutEffect(() => {
    const root = gridRef.current
    if (!root) return
    const pending = submittedIds.filter((id) => !revealedSubmittedIds.current.has(id))
    if (pending.length === 0) return
    const cards: HTMLElement[] = []
    const byId = new Map(
      [...root.querySelectorAll<HTMLElement>('[data-task-id]')].map((node) => [
        node.dataset.taskId,
        node,
      ]),
    )
    for (const id of pending) {
      const card = byId.get(id)
      if (!card) continue
      revealedSubmittedIds.current.add(id)
      cards.push(card)
    }
    const primary = cards[0]
    if (!primary) {
      // 新作品排在最前；列表已往下滚、首行没挂载时先回到网格顶部，挂上后再高亮。
      // 只为确实在列表里的新作品回滚；被筛掉或收在套里的不去打断用户滚动。
      if (virtual && items.some((item) => item.taskId && pending.includes(item.taskId)))
        window.scrollTo({ top: Math.max(0, scrollMargin - 96) })
      return
    }
    revealSubmittedCard(primary)
    const phrase = t('grid.submitted')
    if (submittedAnnouncementRef.current) {
      submittedAnnouncementRef.current = ''
      setSubmittedAnnouncement('')
      requestAnimationFrame(() => {
        submittedAnnouncementRef.current = phrase
        setSubmittedAnnouncement(phrase)
      })
    } else {
      submittedAnnouncementRef.current = phrase
      setSubmittedAnnouncement(phrase)
    }
  }, [
    submittedIds,
    filteredTasks,
    expandedSetIds,
    historyReady,
    limit,
    t,
    virtual,
    scrollMargin,
    firstRow,
    items,
  ])

  if (hero && !historyReady) return <HomeWorksSkeleton />

  if (!filteredTasks.length) {
    if (!unfiltered && (searchQuery || filterFavorite || filterStatus !== 'all')) {
      return (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-sm">{t('grid.noMatches')}</p>
        </div>
      )
    }
    // 灵感推荐只在创作页的冷启动露出；资产·作品空了就说空了，别把探索页搬过来。
    if (!hero)
      return (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-sm">{t('grid.empty')}</p>
        </div>
      )
    return <InspirationEmptyHero />
  }

  return (
    <div
      ref={rootRef}
      data-task-grid-root
      className={`relative ${unfiltered ? '' : 'min-h-[50vh]'}`}
    >
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {submittedAnnouncement}
      </div>
      {virtual ? (
        <div className="pb-6">
          <div ref={gridRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute left-0 top-0 grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
              >
                {itemRows[row.index]?.map((item) => item.node)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div ref={gridRef} className="grid grid-cols-1 gap-4 pb-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => item.node)}
        </div>
      )}
      {limit !== undefined && onExpand && (rows.length > limit || hasMore) && (
        <div className="flex justify-center pb-8">
          <Button
            variant="ghost"
            className="h-10 gap-1 px-3 text-body-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg]:size-3.5"
            onClick={onExpand}
            aria-expanded={false}
          >
            {t('grid.expandMore')}
            <Icon name="chevronDown" />
          </Button>
        </div>
      )}
      {selectionBox && (
        <div
          className="fixed bg-primary/20 border border-primary/50 pointer-events-none z-[30]"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
    </div>
  )
}
