import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import InspirationEmptyHero from '../features/inspiration/components/InspirationEmptyHero'
import { i18next, useTranslation } from '../i18n'
import {
  type LegacyProductJob,
  legacyActionLabels,
  readLegacyProductJobs,
  readLegacyStoryboardTitles,
} from '../lib/legacyProductHistory'
import { groupTasksBySet } from '../lib/setHistory'
import { editOutputImage, removeTask, reuseConfig, sendTaskToCanvas, useStore } from '../store'
import type { TaskRecord } from '../types'
import SetHistoryCard from './SetHistoryCard'
import TaskCard from './TaskCard'

/** 套的名字要落在它自己的记录上；记录还没加载时至少不能把分镜说成商品图。 */
function setFallbackName(task: TaskRecord | undefined): string {
  return task?.origin?.kind === 'storyboard'
    ? i18next.t('set.storyboardFallback', { ns: 'task' })
    : i18next.t('set.productShotFallback', { ns: 'task' })
}

/**
 * 作品列表。只有一种卡：只在平台留有记录的生成先被镜像成本机任务记录（见 `lib/cloudMirror`），
 * 再和本机生成一起按时间倒序排进同一个网格。像素存在哪儿不该从卡片上看出来。
 */
export default function TaskGrid() {
  const { t } = useTranslation('task')
  const tasks = useStore((s) => s.tasks)
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

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
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
  }, [tasks, searchQuery, filterStatus, filterFavorite])

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

    const cards = gridRef.current.querySelectorAll('.task-card-wrapper')
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      const taskId = card.getAttribute('data-task-id')
      if (!taskId) return

      const cardLeft = rect.left + window.scrollX
      const cardRight = rect.right + window.scrollX
      const cardTop = rect.top + window.scrollY
      const cardBottom = rect.bottom + window.scrollY

      const isIntersecting =
        minX < cardRight && maxX > cardLeft && minY < cardBottom && maxY > cardTop

      if (isIntersecting) {
        if (initialSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
      } else if (!initialSelected.has(taskId)) {
        newSelected.delete(taskId)
      }
    })

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

  const renderTask = (task: (typeof tasks)[0]) => (
    <div key={task.id} className="task-card-wrapper" data-task-id={task.id}>
      <TaskCard
        task={task}
        onClick={(e) => {
          if (Date.now() < suppressClickUntil.current) {
            e.preventDefault()
            return
          }
          suppressClickUntil.current = 0
          const isCtrl = isMac ? e.metaKey : e.ctrlKey
          if (isCtrl) {
            useStore.getState().toggleTaskSelection(task.id)
          } else if (selectedTaskIds.length > 0) {
            clearSelection()
            setDetailTaskId(task.id)
          } else {
            setDetailTaskId(task.id)
          }
        }}
        onReuse={() => reuseConfig(task)}
        onEditOutputs={() => editOutputImage(task)}
        onSendToCanvas={() => sendTaskToCanvas(task)}
        onDelete={() => handleDelete(task)}
        isSelected={selectedTaskIds.includes(task.id)}
      />
    </div>
  )

  if (!filteredTasks.length) {
    if (searchQuery || filterFavorite || filterStatus !== 'all') {
      return (
        <div className="text-center py-20 text-muted-foreground">
          <p className="text-sm">{t('grid.noMatches')}</p>
        </div>
      )
    }
    return <InspirationEmptyHero />
  }

  // 两边的卡按同一条时间轴排；套折成一条，落在它最新那条任务的位置上。
  const rows: { at: number; nodes: ReactNode[] }[] = historyItems.map((item) => {
    if (item.kind === 'task') return { at: item.task.createdAt, nodes: [renderTask(item.task)] }
    const expanded = expandedSetIds.includes(item.setId)
    const title = storyboardTitles.get(item.setId)
    const job = title ? undefined : productShotJobs.find((e) => e.id === item.setId)
    return {
      at: Math.max(...item.tasks.map((task) => task.createdAt)),
      nodes: [
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
        />,
        ...(expanded ? item.tasks.map(renderTask) : []),
      ],
    }
  })

  rows.sort((a, b) => b.at - a.at)

  return (
    <div ref={rootRef} data-task-grid-root className="relative min-h-[50vh]">
      <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
        {rows.flatMap((row) => row.nodes)}
      </div>
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
