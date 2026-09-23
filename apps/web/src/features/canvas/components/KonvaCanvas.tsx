import Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Arrow, Image as KImage, Layer, Line, Rect, Stage, Text, Transformer } from 'react-konva'
import { useMobileWorkspace } from '../../../hooks/useMobileWorkspace'
import { useTranslation } from '../../../i18n'
import { mediaIdentity } from '../../../lib/cloudMedia'
import { acceptImageFiles, collectDroppedFiles } from '../../../lib/imageFiles'
import { copySelection, duplicateSelection, pasteClipboard } from '../lib/canvasClipboard'
import type { ArrowEl, CanvasEl, FreedrawEl, TextEl } from '../lib/canvasDoc'
import { newElementId, ZOOM_MAX, ZOOM_MIN } from '../lib/canvasDoc'
import { type CanvasEditor, elementBounds } from '../lib/editor'
import { Box } from '../lib/geometry'
import { getLoadedImage } from '../lib/imageCache'
import { importImageFiles } from '../lib/importImages'
import {
  arrowProps,
  CANVAS_FONT_FAMILY,
  freedrawProps,
  imageProps,
  measureText,
  placeholderProps,
  textProps,
} from '../lib/konvaShapes'
import {
  buildSnapTargets,
  resolveSnap,
  type SnapGuide,
  type SnapTargets,
  selectionBounds,
} from '../lib/snapping'
import { bindCanvasTouch } from '../lib/touchGestures'
import { useTimelineEditor } from '../timelineEditorStore'
import CanvasImageMenu, { type CanvasImageMenuState } from './CanvasImageMenu'
import SelectionInfo from './SelectionInfo'
import TimelineShape from './TimelineShape'

/** 手势里判定「有效箭头 / 笔画」的最小长度（页面单位），低于则丢弃。 */
const MIN_GESTURE_LEN = 3

/** 拖拽吸附判定距离（屏幕像素，换算回页面单位随缩放缩放）。 */
const SNAP_THRESHOLD_PX = 8

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean }
  | { kind: 'draw'; id: string }
  | { kind: 'arrow'; id: string; startX: number; startY: number }
  | { kind: 'erase'; captured: boolean }

/**
 * 双层点阵网格（对齐 tldraw 暗色风格）：细点打底、每 4 格一个亮点。
 * 间距随缩放按 2 的幂自适应，点半径换算回页面坐标使屏幕上恒定大小。
 */

/**
 * 自建无限画布（Konva 渲染）：
 * - 工具：选择（marquee / 拖动 / Transformer 缩放旋转图片）、抓手、画笔、橡皮、箭头、文字
 * - 视口：滚轮平移、⌘/Ctrl+滚轮（触控板捏合）缩放、空格临时抓手
 * - 快捷键：V/H/D/E/A/T 切工具，Del 删除，⌘Z/⌘⇧Z 撤销重做，⌘A 全选，⌘C/⌘V/⌘D 复制粘贴
 * - 外部图片：文件拖入落在指针处；系统剪贴板图片 ⌘V 落视口中心
 * 文档状态全部在 CanvasDoc；本组件是无状态渲染 + 手势翻译层。
 */
/**
 * 命中节点所属的画布元素 id。多数元素就是一个带 id 的节点；时间线是一组节点，点中的是
 * 里面没有 id 的背景，所以往上找第一个带 id 的祖先（到 Layer 为止）。
 */
function elementIdAt(node: Konva.Node | null | undefined): string | undefined {
  for (
    let current = node;
    current && current.getType() !== 'Layer';
    current = current.getParent()
  ) {
    const id = current.id()
    if (id) return id
  }
  return undefined
}

export default function KonvaCanvas({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  const mobile = useMobileWorkspace()
  const doc = editor.doc
  useSyncExternalStore(doc.subscribe, () => doc.version)

  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const dragOriginRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const snapRef = useRef<{ targets: SnapTargets; bounds: Box } | null>(null)
  const guideLayerRef = useRef<Konva.Layer>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [panning, setPanning] = useState(false)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [imageMenu, setImageMenu] = useState<CanvasImageMenuState | null>(null)
  // 拖拽中隐藏虚线选中框：它按模型位置画，而节点位移在 dragend 才落模型，中途会滞留原地
  const [dragging, setDragging] = useState(false)
  // 拖文件进画布时点亮落点。dragenter / dragleave 跨子元素成对乱序触发，只有计数不会中途熄灭。
  const [fileOver, setFileOver] = useState(false)
  const fileDepth = useRef(0)

  const { camera, viewport, tool, selection, editingTextId } = doc
  const selectMode = tool === 'select' && !spaceDown

  useEffect(() => {
    const container = stageRef.current?.container()
    if (!container) return
    return bindCanvasTouch(container, doc, {
      native: (point) =>
        doc.tool === 'select' &&
        Boolean(stageRef.current?.getIntersection(point)?.findAncestor('Transformer')),
      hit: (point) => elementIdAt(stageRef.current?.getIntersection(point)),
      menu: (id, point) => setImageMenu({ id, ...point }),
      active: setPanning,
      interrupt: () => {
        trRef.current?.stopTransform()
        const gesture = gestureRef.current
        gestureRef.current = null
        if (gesture?.kind === 'draw' || gesture?.kind === 'arrow') {
          doc.deleteElements([gesture.id], { history: false })
        } else if (gesture?.kind === 'erase' && gesture.captured) {
          doc.undo()
        }
        setMarquee(null)
        setHoveredId(null)
      },
    })
  }, [doc])

  // ===== 视口尺寸跟随容器 =====
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => doc.setViewport(el.clientWidth, el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc])

  // ===== 键盘 =====
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      return (
        doc.editingTextId !== null ||
        // 全屏编辑时间线时，画布整个让位：它的 Delete / ⌘Z 会删掉或撤掉正在编辑的那条。
        useTimelineEditor.getState().openId !== null ||
        t?.tagName === 'INPUT' ||
        t?.tagName === 'TEXTAREA' ||
        t?.isContentEditable
      )
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return
      if (e.key === ' ') {
        setSpaceDown(true)
        e.preventDefault()
        return
      }
      if (e.metaKey || e.ctrlKey) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault()
            e.shiftKey ? doc.redo() : doc.undo()
            break
          case 'a':
            e.preventDefault()
            doc.setSelection(doc.elements.map((el) => el.id))
            break
          case 'c':
            copySelection(doc)
            break
          case 'd':
            e.preventDefault()
            duplicateSelection(doc)
            break
          // ⌘⌫ 作为删除别名（习惯 Cmd+Delete 的用户按了没反应）
          case 'backspace':
          case 'delete':
            e.preventDefault()
            doc.deleteSelection()
            break
        }
        return
      }
      switch (e.key) {
        case 'v':
        case 'V':
          doc.setTool('select')
          break
        case 'h':
        case 'H':
          doc.setTool('hand')
          break
        // D 对齐线上快捷键；P 兼容保留
        case 'p':
        case 'P':
        case 'd':
        case 'D':
          doc.setTool('pen')
          break
        case 'e':
        case 'E':
          doc.setTool('eraser')
          break
        case 'a':
        case 'A':
          doc.setTool('arrow')
          break
        case 't':
        case 'T':
          doc.setTool('text')
          break
        case 'Delete':
        case 'Backspace':
          doc.deleteSelection()
          break
        case 'Escape':
          doc.setSelection([])
          break
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [doc])

  // ===== 粘贴：系统剪贴板图片优先，其次画布内部剪贴板（⌘C 复制的元素） =====
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      // 输入框里的粘贴（生成条 prompt / 文字编辑）不拦
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (files.length > 0) {
        e.preventDefault()
        const vp = editor.getViewportPageBounds()
        void importImageFiles(editor, files, { x: vp.midX, y: vp.midY })
        return
      }
      if (pasteClipboard(editor.doc).length > 0) e.preventDefault()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [editor])

  // ===== Transformer 绑定选中的图片 / 占位框节点 =====
  // 占位框可拉伸（结果按框 contain 适配，框即构图意图）：自由比例、不旋转；图片锁比例、可旋转。
  useEffect(() => {
    const tr = trRef.current
    const stage = stageRef.current
    if (!tr || !stage) return
    const nodes = [...selection]
      .filter((id) => {
        const type = doc.getElement(id)?.type
        return type === 'image' || type === 'placeholder'
      })
      .map((id) => stage.findOne(`#${id}`))
      .filter((n): n is Konva.Node => Boolean(n))
    tr.nodes(nodes)
  }, [doc.version, selection, doc])

  const transformImagesOnly = [...selection].every(
    (id) => doc.getElement(id)?.type !== 'placeholder',
  )

  // ===== 手势 =====

  const pagePoint = (): { x: number; y: number } | null => {
    const pos = stageRef.current?.getPointerPosition()
    if (!pos) return null
    return { x: camera.x + pos.x / camera.zoom, y: camera.y + pos.y / camera.zoom }
  }

  const onPointerDown = (e: KonvaEventObject<PointerEvent>) => {
    const stage = stageRef.current
    if (!stage) return
    // 中键 / 空格 / 抓手 → 平移
    if (e.evt.button === 1 || spaceDown || tool === 'hand') {
      gestureRef.current = { kind: 'pan', lastX: e.evt.clientX, lastY: e.evt.clientY }
      setPanning(true)
      return
    }
    if (e.evt.button !== 0) return
    const p = pagePoint()
    if (!p) return

    // 绘制类工具阻断浏览器默认行为：mousedown 的默认动作会把焦点切走，
    // 文字工具刚挂载的编辑框会被立即 blur（空文字 → 删除），表现为「点了没反应」。
    if (tool !== 'select') e.evt.preventDefault()

    if (tool === 'pen') {
      doc.captureHistory()
      const el: FreedrawEl = {
        id: newElementId(),
        type: 'freedraw',
        points: [p.x, p.y],
        stroke: doc.penColor,
        strokeWidth: doc.penWidth,
      }
      doc.addElements([el], { history: false })
      gestureRef.current = { kind: 'draw', id: el.id }
      return
    }
    if (tool === 'eraser') {
      doc.setSelection([])
      const g: Gesture = { kind: 'erase', captured: false }
      gestureRef.current = g
      eraseAtPointer(g)
      return
    }
    if (tool === 'arrow') {
      doc.captureHistory()
      const el: ArrowEl = {
        id: newElementId(),
        type: 'arrow',
        points: [p.x, p.y, p.x, p.y],
        stroke: doc.penColor,
        strokeWidth: doc.penWidth,
      }
      doc.addElements([el], { history: false })
      gestureRef.current = { kind: 'arrow', id: el.id, startX: p.x, startY: p.y }
      return
    }
    if (tool === 'text') {
      doc.captureHistory()
      const { width, height } = measureText('', doc.textFontSize)
      const el: TextEl = {
        id: newElementId(),
        type: 'text',
        x: p.x,
        y: p.y - height / 2,
        text: '',
        fontSize: doc.textFontSize,
        fill: doc.penColor,
        width,
        height,
      }
      doc.addElements([el], { history: false })
      doc.setEditingText(el.id)
      doc.setTool('select')
      return
    }
    // select 工具：点在空白处 → marquee
    if (e.target === stage) {
      const additive = e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey
      if (!additive) doc.setSelection([])
      gestureRef.current = { kind: 'marquee', startX: p.x, startY: p.y, additive }
      setMarquee(new Box(p.x, p.y, 0, 0))
    }
  }

  /** 橡皮：删除指针下的元素（占位框是任务状态，不给擦）。首次真正擦到才入 undo 栈。 */
  const eraseAtPointer = (g: Extract<Gesture, { kind: 'erase' }>) => {
    const stage = stageRef.current
    const pos = stage?.getPointerPosition()
    if (!stage || !pos) return
    const id = elementIdAt(stage.getIntersection(pos))
    const el = id ? doc.getElement(id) : undefined
    if (!el || el.type === 'placeholder') return
    if (!g.captured) {
      doc.captureHistory()
      g.captured = true
    }
    doc.deleteElements([el.id], { history: false })
  }

  const onPointerMove = (e: KonvaEventObject<PointerEvent>) => {
    const g = gestureRef.current
    if (!g) return
    if (g.kind === 'erase') {
      eraseAtPointer(g)
      return
    }
    if (g.kind === 'pan') {
      const dx = e.evt.clientX - g.lastX
      const dy = e.evt.clientY - g.lastY
      g.lastX = e.evt.clientX
      g.lastY = e.evt.clientY
      const current = doc.camera
      doc.setCamera({ x: current.x - dx / current.zoom, y: current.y - dy / current.zoom })
      return
    }
    const p = pagePoint()
    if (!p) return
    if (g.kind === 'draw') {
      const el = doc.getElement(g.id)
      if (el?.type !== 'freedraw') return
      const pts = el.points
      const lastX = pts[pts.length - 2]
      const lastY = pts[pts.length - 1]
      const minDist = 0.75 / camera.zoom
      if (Math.hypot(p.x - lastX, p.y - lastY) < minDist) return
      doc.updateElements([{ id: g.id, patch: { points: [...pts, p.x, p.y] } }])
      return
    }
    if (g.kind === 'arrow') {
      doc.updateElements([{ id: g.id, patch: { points: [g.startX, g.startY, p.x, p.y] } }])
      return
    }
    if (g.kind === 'marquee') {
      const x = Math.min(g.startX, p.x)
      const y = Math.min(g.startY, p.y)
      setMarquee(new Box(x, y, Math.abs(p.x - g.startX), Math.abs(p.y - g.startY)))
    }
  }

  const onPointerUp = () => {
    const g = gestureRef.current
    gestureRef.current = null
    setPanning(false)
    if (!g) return
    if (g.kind === 'arrow') {
      const el = doc.getElement(g.id)
      if (el?.type === 'arrow') {
        const [x1, y1, x2, y2] = el.points
        if (Math.hypot(x2 - x1, y2 - y1) < MIN_GESTURE_LEN)
          doc.deleteElements([g.id], { history: false })
      }
    }
    if (g.kind === 'marquee') {
      setMarquee(null)
      const box = marquee
      if (box && (box.w > 1 || box.h > 1)) {
        const hits = doc.elements.filter((el) => elementBounds(el).collides(box)).map((el) => el.id)
        doc.setSelection(g.additive ? [...doc.selection, ...hits] : hits)
      }
    }
  }

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const pos = stageRef.current?.getPointerPosition()
      if (!pos) return
      doc.zoomAt(pos.x, pos.y, camera.zoom * Math.exp(-e.evt.deltaY * 0.01))
    } else {
      doc.setCamera({
        x: camera.x + e.evt.deltaX / camera.zoom,
        y: camera.y + e.evt.deltaY / camera.zoom,
      })
    }
  }

  // ===== 元素选择 / 拖动 =====

  const onElementClick = (e: KonvaEventObject<PointerEvent>, id: string) => {
    if (!selectMode) return
    e.cancelBubble = true
    // Shift 与 ⌘/Ctrl 都是「加选」：桌面软件两种习惯并存，只认一种会让另一半人以为多选坏了。
    if (e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey) {
      const next = new Set(doc.selection)
      next.has(id) ? next.delete(id) : next.add(id)
      doc.setSelection(next)
    } else {
      doc.setSelection([id])
    }
  }

  /** 吸附参考线走命令式 Konva 层：拖拽逐帧更新，不触发 React 重渲染（重渲染会把其余选中节点的视觉位移重置回模型位置）。 */
  const drawGuides = (guides: SnapGuide[]) => {
    const layer = guideLayerRef.current
    if (!layer) return
    layer.destroyChildren()
    for (const g of guides) {
      layer.add(
        new Konva.Line({
          points:
            g.axis === 'x' ? [g.value, g.from, g.value, g.to] : [g.from, g.value, g.to, g.value],
          stroke: '#38bdf8',
          strokeWidth: 1 / camera.zoom,
        }),
      )
    }
    layer.batchDraw()
  }

  const onDragStart = (e: KonvaEventObject<DragEvent>, id: string) => {
    if (!doc.selection.has(id)) doc.setSelection([id])
    doc.captureHistory()
    setHoveredId(null)
    setDragging(true)
    const stage = stageRef.current
    const origins = new Map<string, { x: number; y: number }>()
    for (const selId of doc.selection) {
      const node = stage?.findOne(`#${selId}`)
      if (node) origins.set(selId, node.position())
    }
    dragOriginRef.current = origins
    const bounds = selectionBounds(editor, doc.selection)
    snapRef.current = bounds
      ? { targets: buildSnapTargets(doc.elements, new Set(doc.selection)), bounds }
      : null
    e.cancelBubble = true
  }

  const onDragMove = (e: KonvaEventObject<DragEvent>, id: string) => {
    // 拖动主体由 Konva 负责；其余选中元素跟随同一位移（视觉层，dragend 落模型）
    const origins = dragOriginRef.current
    const stage = stageRef.current
    if (!origins || !stage) return
    const origin = origins.get(id)
    if (!origin) return
    const node = e.target
    let dx = node.x() - origin.x
    let dy = node.y() - origin.y
    // 吸附：选区包围盒贴近其他元素的边/中心时吸上去（按住 ⌥ 临时禁用）
    const snap = snapRef.current
    if (snap && !e.evt.altKey) {
      const moved = new Box(snap.bounds.x + dx, snap.bounds.y + dy, snap.bounds.w, snap.bounds.h)
      const { adjustX, adjustY, guides } = resolveSnap(
        snap.targets,
        moved,
        SNAP_THRESHOLD_PX / camera.zoom,
      )
      dx += adjustX
      dy += adjustY
      node.position({ x: origin.x + dx, y: origin.y + dy })
      drawGuides(guides)
    } else {
      drawGuides([])
    }
    for (const [selId, from] of origins) {
      if (selId === id) continue
      stage.findOne(`#${selId}`)?.position({ x: from.x + dx, y: from.y + dy })
    }
  }

  const onDragEnd = (e: KonvaEventObject<DragEvent>, id: string) => {
    const origins = dragOriginRef.current
    dragOriginRef.current = null
    snapRef.current = null
    drawGuides([])
    setDragging(false)
    const stage = stageRef.current
    if (!origins || !stage) return
    const origin = origins.get(id)
    if (!origin) return
    const dx = e.target.x() - origin.x
    const dy = e.target.y() - origin.y
    const patches: Array<{ id: string; patch: Partial<CanvasEl> }> = []
    for (const [selId] of origins) {
      const el = doc.getElement(selId)
      if (!el) continue
      if (el.type === 'freedraw' || el.type === 'arrow') {
        const moved = el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
        patches.push({ id: selId, patch: { points: moved as ArrowEl['points'] } })
        // points 已含位移，节点自身归零（props 里 x/y 恒为 0，需手动复位）
        stage.findOne(`#${selId}`)?.position({ x: 0, y: 0 })
      } else {
        patches.push({ id: selId, patch: { x: el.x + dx, y: el.y + dy } })
      }
    }
    doc.updateElements(patches)
  }

  const onTransformEnd = (e: KonvaEventObject<Event>, id: string) => {
    const node = e.target
    const el = doc.getElement(id)
    if (el?.type === 'image') {
      const patch = {
        x: node.x(),
        y: node.y(),
        width: Math.max(4, el.width * node.scaleX()),
        height: Math.max(4, el.height * node.scaleY()),
        rotation: node.rotation(),
      }
      node.scale({ x: 1, y: 1 })
      doc.updateElements([{ id, patch }])
      return
    }
    if (el?.type === 'placeholder') {
      // 模型无 rotation 字段，缩放把手也不给旋转（transformImagesOnly 关掉了），归零兜底
      const patch = {
        x: node.x(),
        y: node.y(),
        width: Math.max(60, el.width * node.scaleX()),
        height: Math.max(60, el.height * node.scaleY()),
      }
      node.scale({ x: 1, y: 1 })
      node.rotation(0)
      doc.updateElements([{ id, patch }])
    }
  }

  // ===== 文字编辑浮层 =====
  const editingText = editingTextId
    ? (doc.getElement(editingTextId) as TextEl | undefined)
    : undefined

  const commitText = (raw: string) => {
    const id = editingTextId
    const fontSize = editingText?.fontSize ?? doc.textFontSize
    if (!id) return
    doc.setEditingText(null)
    const trimmed = raw.replace(/\s+$/, '')
    if (!trimmed) {
      // 空文字 = 取消创建/清空即删除；创建时已 capture，这里不再入栈
      doc.deleteElements([id], { history: false })
      return
    }
    const { width, height } = measureText(trimmed, fontSize)
    doc.updateElements([{ id, patch: { text: trimmed, width, height } }])
  }

  let cursor = 'default'
  if (panning) cursor = 'grabbing'
  else if (spaceDown || tool === 'hand') cursor = 'grab'
  else if (tool === 'pen' || tool === 'arrow' || tool === 'eraser') cursor = 'crosshair'
  else if (tool === 'text') cursor = 'text'

  // hover 高亮（未选中时的轻描边提示，仅选择工具下）
  const hoveredEl =
    selectMode && hoveredId && !selection.has(hoveredId) ? doc.getElement(hoveredId) : undefined
  const hoverBox = hoveredEl ? elementBounds(hoveredEl) : null

  // 选中的非图片元素画虚线外框（图片走 Transformer 的框）
  const outlineBoxes = useMemo(
    () =>
      [...selection]
        .map((id) => doc.getElement(id))
        .filter((el): el is CanvasEl => Boolean(el) && el?.type !== 'image')
        .map((el) => ({ id: el.id, box: elementBounds(el) })),
    [selection, doc.version, doc],
  )

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      style={{
        cursor,
        touchAction: 'none',
        backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)',
        backgroundSize: '20px 20px',
        backgroundPosition: `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`,
      }}
      onContextMenu={(e) => {
        // 原生菜单在画布上只会抓到空的顶层图层，一律拦掉；指在图片上就给自己的菜单。
        e.preventDefault()
        const stage = stageRef.current
        const rect = containerRef.current?.getBoundingClientRect()
        if (!stage || !rect) return
        const node = stage.getIntersection({ x: e.clientX - rect.left, y: e.clientY - rect.top })
        const id = elementIdAt(node)
        const el = id ? doc.getElement(id) : undefined
        if (el?.type !== 'image') return
        setImageMenu({ id: el.id, x: e.clientX, y: e.clientY })
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        fileDepth.current += 1
        setFileOver(true)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      // 离开事件不问带的是什么：有的浏览器这时已经不给 types，问了高亮就熄不掉。
      onDragLeave={() => {
        if (fileDepth.current === 0) return
        fileDepth.current -= 1
        if (fileDepth.current <= 0) setFileOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        fileDepth.current = 0
        setFileOver(false)
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const drop = {
          x: camera.x + (e.clientX - rect.left) / camera.zoom,
          y: camera.y + (e.clientY - rect.top) / camera.zoom,
        }
        // collectDroppedFiles 必须在这一拍同步调用：await 之后 DataTransfer.items 就空了。
        void collectDroppedFiles(e.dataTransfer).then(({ files }) => {
          // 与输入框那块落点同一道闸：只留图片、太大的丢掉，各提示一次。
          void importImageFiles(editor, acceptImageFiles(files), drop)
        })
      }}
    >
      {!dragging && !panning && <SelectionInfo doc={doc} />}
      {/* 拖到画布上的落点提示：与输入框那块落点同一套说法，不然「能不能往这儿拖」全靠猜。 */}
      {fileOver && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-primary border-dashed bg-background/70 backdrop-blur-[2px]">
          <span className="rounded-lg bg-card px-3 py-1.5 text-sm font-medium shadow-md">
            {t('drop.hint')}
          </span>
        </div>
      )}
      <Stage
        ref={stageRef}
        width={viewport.width}
        height={viewport.height}
        scaleX={camera.zoom}
        scaleY={camera.zoom}
        x={-camera.x * camera.zoom}
        y={-camera.y * camera.zoom}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <Layer listening={false}></Layer>
        <Layer>
          {doc.elements.map((el) => {
            const common = {
              id: el.id,
              draggable: selectMode,
              onPointerClick: (e: KonvaEventObject<PointerEvent>) => onElementClick(e, el.id),
              onDragStart: (e: KonvaEventObject<DragEvent>) => onDragStart(e, el.id),
              onDragMove: (e: KonvaEventObject<DragEvent>) => onDragMove(e, el.id),
              onDragEnd: (e: KonvaEventObject<DragEvent>) => onDragEnd(e, el.id),
              // 手势 / 拖拽期间不更新 hover：setState 触发的重渲染会干扰视觉层位移
              onPointerEnter: () => {
                if (selectMode && !gestureRef.current && !dragOriginRef.current) setHoveredId(el.id)
              },
              onPointerLeave: () => setHoveredId((prev) => (prev === el.id ? null : prev)),
            }
            switch (el.type) {
              case 'image': {
                if (
                  mediaIdentity(doc.files[el.fileId]) &&
                  !doc.selection.has(el.id) &&
                  !elementBounds(el).collides(editor.getViewportPageBounds())
                )
                  return null
                const img = getLoadedImage(el.fileId, doc.files[el.fileId], () =>
                  doc.notifyAssetLoaded(),
                )
                if (!img) return null
                return (
                  <KImage
                    key={el.id}
                    {...common}
                    image={img}
                    {...imageProps(el)}
                    onTransformEnd={(e) => onTransformEnd(e, el.id)}
                  />
                )
              }
              case 'freedraw':
                return (
                  <Line
                    key={el.id}
                    {...common}
                    {...freedrawProps(el)}
                    x={0}
                    y={0}
                    hitStrokeWidth={14}
                  />
                )
              case 'arrow':
                return (
                  <Arrow
                    key={el.id}
                    {...common}
                    {...arrowProps(el)}
                    x={0}
                    y={0}
                    hitStrokeWidth={14}
                  />
                )
              case 'text':
                if (el.id === editingTextId) return null
                return (
                  <Text
                    key={el.id}
                    {...common}
                    {...textProps(el)}
                    onPointerDblClick={() => doc.setEditingText(el.id)}
                  />
                )
              case 'placeholder':
                return (
                  <Rect
                    key={el.id}
                    {...common}
                    {...placeholderProps(el)}
                    onTransformEnd={(e) => onTransformEnd(e, el.id)}
                  />
                )
              case 'timeline':
                return (
                  <TimelineShape
                    key={el.id}
                    el={el}
                    doc={doc}
                    labels={{ title: t('timeline.title'), missing: t('timeline.missing') }}
                    common={common}
                  />
                )
            }
          })}
        </Layer>
        {/* 吸附参考线：命令式绘制（drawGuides），React 不往里渲染子节点 */}
        <Layer ref={guideLayerRef} listening={false} />
        <Layer listening={false}>
          {hoverBox && (
            <Rect
              x={hoverBox.x}
              y={hoverBox.y}
              width={hoverBox.w}
              height={hoverBox.h}
              stroke="rgba(96,165,250,0.55)"
              strokeWidth={2 / camera.zoom}
            />
          )}
          {!dragging &&
            outlineBoxes.map(({ id, box }) => (
              <Rect
                key={`outline-${id}`}
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                stroke="#3b82f6"
                strokeWidth={1.5 / camera.zoom}
                dash={[4 / camera.zoom, 4 / camera.zoom]}
              />
            ))}
          {marquee && (
            <Rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              fill="rgba(59,130,246,0.12)"
              stroke="#3b82f6"
              strokeWidth={1 / camera.zoom}
            />
          )}
        </Layer>
        <Layer>
          <Transformer
            ref={trRef}
            keepRatio={transformImagesOnly}
            rotateEnabled={transformImagesOnly}
            flipEnabled={false}
            enabledAnchors={
              transformImagesOnly
                ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
                : [
                    'top-left',
                    'top-right',
                    'bottom-left',
                    'bottom-right',
                    'middle-left',
                    'middle-right',
                    'top-center',
                    'bottom-center',
                  ]
            }
            anchorSize={mobile ? 18 : 9}
            anchorCornerRadius={4}
            anchorStroke="#3b82f6"
            anchorFill="#ffffff"
            borderStroke="#3b82f6"
            onTransformStart={() => doc.captureHistory()}
          />
        </Layer>
      </Stage>
      {mobile && (
        <div className="pointer-events-none absolute bottom-2 left-16 right-3 text-center text-[11px] text-muted-foreground">
          {t('touch.hint')}
        </div>
      )}
      <CanvasImageMenu menu={imageMenu} doc={doc} onClose={() => setImageMenu(null)} />
      {editingText && (
        <textarea
          autoFocus
          defaultValue={editingText.text}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commitText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          className="absolute resize-none overflow-hidden bg-transparent outline-none"
          style={{
            left: (editingText.x - camera.x) * camera.zoom,
            top: (editingText.y - camera.y) * camera.zoom,
            minWidth: 200,
            minHeight: editingText.fontSize * 1.3 * camera.zoom + 8,
            fontSize: editingText.fontSize * camera.zoom,
            lineHeight: 1.3,
            fontFamily: CANVAS_FONT_FAMILY,
            color: editingText.fill,
            border: '1px dashed rgba(59,130,246,0.7)',
            borderRadius: 4,
            padding: 0,
          }}
        />
      )}
    </div>
  )
}
