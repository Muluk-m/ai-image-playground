import {
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { i18next } from '../i18n'
import { useStore } from '../store'

/** 一张可框选卡片在页面坐标里的位置。由调用方按布局算，滚出视口未挂载的卡也要给。 */
export interface SelectableCardRect {
  readonly taskId: string
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

interface SelectionBox {
  startPageX: number
  startPageY: number
  currentPageX: number
  currentPageY: number
}

const DRAG_THRESHOLD = 6
const SCROLL_EDGE = 40
const SCROLL_STEP = 15
const SCROLL_INTERVAL_MS = 16
const SUPPRESS_CLICK_MS = 250

const isMacPlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

/**
 * 作品卡的框选：只在 `[data-drag-select-surface]` 里起手，拖过的卡按起手时的选中态取反，
 * 贴近视口上下沿时自动滚动。卡片位置由 `cardRects` 按布局给出——虚拟列表里滚出去的卡没有 DOM，
 * 照样要能被框进来。选中集合放在全局 store 里，卡片卸载不影响选中态。
 */
export function useDragSelection(cardRects: RefObject<() => readonly SelectableCardRect[]>) {
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const dragScrollInterval = useRef<number | null>(null)
  const dragScrollDirection = useRef<-1 | 1 | null>(null)
  const lastToastTime = useRef(0)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = isMacPlatform()

  useEffect(() => {
    const getPagePoint = (clientX: number, clientY: number) => ({
      pageX: clientX + window.scrollX,
      pageY: clientY + window.scrollY,
    })

    const updateSelectionFromPoint = (pageX: number, pageY: number) => {
      const start = dragStart.current
      if (!start) return
      const minX = Math.min(start.pageX, pageX)
      const maxX = Math.max(start.pageX, pageX)
      const minY = Math.min(start.pageY, pageY)
      const maxY = Math.max(start.pageY, pageY)
      const initialSelected = new Set(initialSelection.current)
      const next = new Set(initialSelection.current)
      for (const card of cardRects.current?.() ?? []) {
        const hit = minX < card.right && maxX > card.left && minY < card.bottom && maxY > card.top
        if (hit) {
          if (initialSelected.has(card.taskId)) next.delete(card.taskId)
          else next.add(card.taskId)
        } else if (!initialSelected.has(card.taskId)) {
          next.delete(card.taskId)
        }
      }
      setSelectedTaskIds(Array.from(next))
    }

    const stopDragScroll = () => {
      if (dragScrollInterval.current) {
        clearInterval(dragScrollInterval.current)
        dragScrollInterval.current = null
      }
      dragScrollDirection.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollInterval.current && dragScrollDirection.current === direction) return
      stopDragScroll()
      dragScrollDirection.current = direction
      dragScrollInterval.current = window.setInterval(() => {
        window.scrollBy({ top: direction * SCROLL_STEP, behavior: 'instant' })
      }, SCROLL_INTERVAL_MS)
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
        suppressClickUntil.current = Date.now() + SUPPRESS_CLICK_MS
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

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      if (target.closest('button, a, input, textarea, select')) return
      const point = getPagePoint(e.clientX, e.clientY)
      startedOnCard.current = Boolean(target.closest('.task-card-wrapper, [data-selectable-card]'))
      startedWithCtrl.current = isMac ? e.metaKey : e.ctrlKey
      initialSelection.current = [...useStore.getState().selectedTaskIds]
      isDragging.current = true
      hasDragged.current = false
      dragStart.current = point
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      document.body.classList.add('select-none')
      document.body.classList.add('drag-selecting')
      setSelectionBox({
        startPageX: point.pageX,
        startPageY: point.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      e.preventDefault()
    }

    const handleMouseMove = (e: MouseEvent) => {
      const start = dragStart.current
      if (!isDragging.current || !start) return
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < DRAG_THRESHOLD && !hasDragged.current) return
      hasDragged.current = true
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
      e.preventDefault()
      if (e.clientY < SCROLL_EDGE) startDragScroll(-1)
      else if (e.clientY > window.innerHeight - SCROLL_EDGE) startDragScroll(1)
      else stopDragScroll()
    }

    const handleScroll = () => {
      const start = dragStart.current
      const last = lastClientPoint.current
      if (!isDragging.current || !start || !last || !hasDragged.current) return
      const point = getPagePoint(last.x, last.y)
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const handleWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const now = Date.now()
      if (now - lastToastTime.current > 3000) {
        lastToastTime.current = now
        useStore
          .getState()
          .showToast(
            i18next.t('grid.releaseKeyHint', { ns: 'task', key: isMac ? '⌘' : 'Ctrl' }),
            'info',
          )
      }
    }

    const handleMouseUp = () => endSelection(true, true)

    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    document.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      stopDragScroll()
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('mousemove', handleMouseMove, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
      document.removeEventListener('wheel', handleWheel, true)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [cardRects, clearSelection, setSelectedTaskIds, isMac])

  /** 卡片的点击：框选刚结束的那一下吞掉；Ctrl/⌘ 点按切换选中；否则清掉选中并打开详情。 */
  const openCard = useCallback(
    (taskId: string, e: ReactMouseEvent | ReactTouchEvent) => {
      if (Date.now() < suppressClickUntil.current) {
        e.preventDefault()
        return
      }
      suppressClickUntil.current = 0
      if (isMac ? e.metaKey : e.ctrlKey) {
        useStore.getState().toggleTaskSelection(taskId)
        return
      }
      if (useStore.getState().selectedTaskIds.length > 0) clearSelection()
      setDetailTaskId(taskId)
    },
    [clearSelection, setDetailTaskId, isMac],
  )

  return { selectionBox, openCard }
}

/** 框选时画的那个矩形；页面坐标换回视口坐标。 */
export function DragSelectionRect({ box }: { box: SelectionBox | null }) {
  if (!box) return null
  return (
    <div
      className="pointer-events-none fixed z-[30] border border-primary/50 bg-primary/20"
      style={{
        left: Math.min(box.startPageX, box.currentPageX) - window.scrollX,
        top: Math.min(box.startPageY, box.currentPageY) - window.scrollY,
        width: Math.abs(box.currentPageX - box.startPageX),
        height: Math.abs(box.currentPageY - box.startPageY),
      }}
    />
  )
}
