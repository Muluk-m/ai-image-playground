import Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Arrow,
  Image as KImage,
  Layer,
  Line,
  Rect,
  Shape,
  Stage,
  Text,
  Transformer,
} from 'react-konva'
import type { ArrowEl, CanvasDoc, CanvasEl, FreedrawEl, TextEl } from '../lib/canvasDoc'
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
  placeholderProps,
  textProps,
} from '../lib/konvaShapes'

/** 画笔 / 箭头默认线宽（页面坐标单位）。 */
const STROKE_WIDTH = 4
/** 文字默认字号（页面坐标单位）。 */
const TEXT_FONT_SIZE = 28
/** 手势里判定「有效箭头 / 笔画」的最小长度（页面单位），低于则丢弃。 */
const MIN_GESTURE_LEN = 3

type Gesture =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'marquee'; startX: number; startY: number; additive: boolean }
  | { kind: 'draw'; id: string }
  | { kind: 'arrow'; id: string; startX: number; startY: number }

function measureText(text: string, fontSize: number): { width: number; height: number } {
  const node = new Konva.Text({
    text: text || ' ',
    fontSize,
    fontFamily: CANVAS_FONT_FAMILY,
    lineHeight: 1.3,
  })
  return { width: node.width(), height: node.height() }
}

/**
 * 双层点阵网格（对齐 tldraw 暗色风格）：细点打底、每 4 格一个亮点。
 * 间距随缩放按 2 的幂自适应，点半径换算回页面坐标使屏幕上恒定大小。
 */
function DotGrid({ doc }: { doc: CanvasDoc }) {
  const { camera, viewport } = doc
  return (
    <Shape
      listening={false}
      // 相机/视口任一变化都要触发重绘：传成 props 让 react-konva 感知
      camX={camera.x}
      camY={camera.y}
      camZoom={camera.zoom}
      vpW={viewport.width}
      vpH={viewport.height}
      sceneFunc={(ctx) => {
        let spacing = 18
        while (spacing * camera.zoom < 12) spacing *= 2
        while (spacing * camera.zoom > 44 && spacing > 3) spacing /= 2
        const x0 = Math.floor(camera.x / spacing) * spacing
        const y0 = Math.floor(camera.y / spacing) * spacing
        const x1 = camera.x + viewport.width / camera.zoom
        const y1 = camera.y + viewport.height / camera.zoom
        const isMajor = (v: number) => Math.round(v / spacing) % 4 === 0
        // 两遍绘制：细点（暗）与主点（亮），主点稍大
        for (const pass of ['minor', 'major'] as const) {
          const r = (pass === 'major' ? 1.6 : 1) / camera.zoom
          ctx.beginPath()
          for (let x = x0; x <= x1; x += spacing) {
            for (let y = y0; y <= y1; y += spacing) {
              const onMajor = isMajor(x) && isMajor(y)
              if ((pass === 'major') !== onMajor) continue
              ctx.moveTo(x + r, y)
              ctx.arc(x, y, r, 0, Math.PI * 2)
            }
          }
          ctx.setAttr(
            'fillStyle',
            pass === 'major' ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.10)',
          )
          ctx.fill()
        }
      }}
    />
  )
}

/**
 * 自建无限画布（Konva 渲染）：
 * - 工具：选择（marquee / 拖动 / Transformer 缩放旋转图片）、抓手、画笔、箭头、文字
 * - 视口：滚轮平移、⌘/Ctrl+滚轮（触控板捏合）缩放、空格临时抓手
 * - 快捷键：V/H/P/A/T 切工具，Del 删除，⌘Z / ⌘⇧Z 撤销重做
 * 文档状态全部在 CanvasDoc；本组件是无状态渲染 + 手势翻译层。
 */
export default function KonvaCanvas({ editor }: { editor: CanvasEditor }) {
  const doc = editor.doc
  useSyncExternalStore(doc.subscribe, () => doc.version)

  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const dragOriginRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [panning, setPanning] = useState(false)
  const [marquee, setMarquee] = useState<Box | null>(null)

  const { camera, viewport, tool, selection, editingTextId } = doc
  const selectMode = tool === 'select' && !spaceDown

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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? doc.redo() : doc.undo()
        return
      }
      if (e.metaKey || e.ctrlKey) return
      switch (e.key) {
        case 'v':
        case 'V':
          doc.setTool('select')
          break
        case 'h':
        case 'H':
          doc.setTool('hand')
          break
        case 'p':
        case 'P':
          doc.setTool('pen')
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
          if (doc.selection.size > 0) doc.deleteElements([...doc.selection])
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

  // ===== 剪贴板粘贴图片 =====
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      // 输入框里的粘贴（生成条 prompt / 文字编辑）不拦
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (files.length === 0) return
      e.preventDefault()
      const vp = editor.getViewportPageBounds()
      void importImageFiles(editor, files, { x: vp.midX, y: vp.midY })
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [editor])

  // ===== Transformer 绑定选中的图片节点 =====
  // biome-ignore lint/correctness/useExhaustiveDependencies: doc.version 驱动（选区/元素变化后重绑节点）
  useEffect(() => {
    const tr = trRef.current
    const stage = stageRef.current
    if (!tr || !stage) return
    const nodes = [...selection]
      .filter((id) => doc.getElement(id)?.type === 'image')
      .map((id) => stage.findOne(`#${id}`))
      .filter((n): n is Konva.Node => Boolean(n))
    tr.nodes(nodes)
  }, [doc.version, selection, doc])

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

    if (tool === 'pen') {
      doc.captureHistory()
      const el: FreedrawEl = {
        id: newElementId(),
        type: 'freedraw',
        points: [p.x, p.y],
        stroke: doc.penColor,
        strokeWidth: STROKE_WIDTH,
      }
      doc.addElements([el], { history: false })
      gestureRef.current = { kind: 'draw', id: el.id }
      return
    }
    if (tool === 'arrow') {
      doc.captureHistory()
      const el: ArrowEl = {
        id: newElementId(),
        type: 'arrow',
        points: [p.x, p.y, p.x, p.y],
        stroke: doc.penColor,
        strokeWidth: STROKE_WIDTH,
      }
      doc.addElements([el], { history: false })
      gestureRef.current = { kind: 'arrow', id: el.id, startX: p.x, startY: p.y }
      return
    }
    if (tool === 'text') {
      doc.captureHistory()
      const { width, height } = measureText('', TEXT_FONT_SIZE)
      const el: TextEl = {
        id: newElementId(),
        type: 'text',
        x: p.x,
        y: p.y - height / 2,
        text: '',
        fontSize: TEXT_FONT_SIZE,
        fill: '#f8fafc',
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
      if (!e.evt.shiftKey) doc.setSelection([])
      gestureRef.current = { kind: 'marquee', startX: p.x, startY: p.y, additive: e.evt.shiftKey }
      setMarquee(new Box(p.x, p.y, 0, 0))
    }
  }

  const onPointerMove = (e: KonvaEventObject<PointerEvent>) => {
    const g = gestureRef.current
    if (!g) return
    if (g.kind === 'pan') {
      const dx = e.evt.clientX - g.lastX
      const dy = e.evt.clientY - g.lastY
      g.lastX = e.evt.clientX
      g.lastY = e.evt.clientY
      doc.setCamera({ x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom })
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
    if (e.evt.shiftKey) {
      const next = new Set(doc.selection)
      next.has(id) ? next.delete(id) : next.add(id)
      doc.setSelection(next)
    } else {
      doc.setSelection([id])
    }
  }

  const onDragStart = (e: KonvaEventObject<DragEvent>, id: string) => {
    if (!doc.selection.has(id)) doc.setSelection([id])
    doc.captureHistory()
    const stage = stageRef.current
    const origins = new Map<string, { x: number; y: number }>()
    for (const selId of doc.selection) {
      const node = stage?.findOne(`#${selId}`)
      if (node) origins.set(selId, node.position())
    }
    dragOriginRef.current = origins
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
    const dx = node.x() - origin.x
    const dy = node.y() - origin.y
    for (const [selId, from] of origins) {
      if (selId === id) continue
      stage.findOne(`#${selId}`)?.position({ x: from.x + dx, y: from.y + dy })
    }
  }

  const onDragEnd = (e: KonvaEventObject<DragEvent>, id: string) => {
    const origins = dragOriginRef.current
    dragOriginRef.current = null
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
    if (el?.type !== 'image') return
    const patch = {
      x: node.x(),
      y: node.y(),
      width: Math.max(4, el.width * node.scaleX()),
      height: Math.max(4, el.height * node.scaleY()),
      rotation: node.rotation(),
    }
    node.scale({ x: 1, y: 1 })
    doc.updateElements([{ id, patch }])
  }

  // ===== 文字编辑浮层 =====
  const editingText = editingTextId
    ? (doc.getElement(editingTextId) as TextEl | undefined)
    : undefined

  const commitText = (raw: string) => {
    const id = editingTextId
    if (!id) return
    doc.setEditingText(null)
    const trimmed = raw.replace(/\s+$/, '')
    if (!trimmed) {
      // 空文字 = 取消创建/清空即删除；创建时已 capture，这里不再入栈
      doc.deleteElements([id], { history: false })
      return
    }
    const { width, height } = measureText(trimmed, TEXT_FONT_SIZE)
    doc.updateElements([{ id, patch: { text: trimmed, width, height } }])
  }

  const cursor = panning
    ? 'grabbing'
    : spaceDown || tool === 'hand'
      ? 'grab'
      : tool === 'pen' || tool === 'arrow'
        ? 'crosshair'
        : tool === 'text'
          ? 'text'
          : 'default'

  // 选中的非图片元素画虚线外框（图片走 Transformer 的框）
  const outlineBoxes = useMemo(
    () =>
      [...selection]
        .map((id) => doc.getElement(id))
        .filter((el): el is CanvasEl => Boolean(el) && el?.type !== 'image')
        .map((el) => ({ id: el.id, box: elementBounds(el) })),
    // biome-ignore lint/correctness/useExhaustiveDependencies: doc.version 驱动
    [selection, doc.version, doc],
  )

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      style={{ cursor }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const drop = {
          x: camera.x + (e.clientX - rect.left) / camera.zoom,
          y: camera.y + (e.clientY - rect.top) / camera.zoom,
        }
        void importImageFiles(editor, [...e.dataTransfer.files], drop)
      }}
    >
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
        onWheel={onWheel}
      >
        <Layer listening={false}>
          <DotGrid doc={doc} />
        </Layer>
        <Layer>
          {doc.elements.map((el) => {
            const common = {
              id: el.id,
              draggable: selectMode,
              onPointerClick: (e: KonvaEventObject<PointerEvent>) => onElementClick(e, el.id),
              onDragStart: (e: KonvaEventObject<DragEvent>) => onDragStart(e, el.id),
              onDragMove: (e: KonvaEventObject<DragEvent>) => onDragMove(e, el.id),
              onDragEnd: (e: KonvaEventObject<DragEvent>) => onDragEnd(e, el.id),
            }
            switch (el.type) {
              case 'image': {
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
                return <Rect key={el.id} {...common} {...placeholderProps(el)} />
            }
          })}
        </Layer>
        <Layer listening={false}>
          {outlineBoxes.map(({ id, box }) => (
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
            keepRatio
            rotateEnabled
            flipEnabled={false}
            enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
            anchorSize={9}
            anchorCornerRadius={4}
            anchorStroke="#3b82f6"
            anchorFill="#ffffff"
            borderStroke="#3b82f6"
            onTransformStart={() => doc.captureHistory()}
          />
        </Layer>
      </Stage>
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
