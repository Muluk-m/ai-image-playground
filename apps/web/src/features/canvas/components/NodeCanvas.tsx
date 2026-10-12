import {
  type CanvasAnnotation,
  type CanvasNode,
  type CanvasSnapshot,
  canvasOrigin,
  connectCanvasNodes,
  deleteCanvasNode,
  type LegacyCanvasElement,
  moveCanvasNodes,
  type PendingGeneration,
  readCanvasDocument,
  reconcileLegacyElements,
  synchronizeLegacyElements,
} from '@image-playground/shared'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  getViewportForBounds,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Rect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  createContext,
  memo,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { acceptImageFiles, collectDroppedFiles } from '../../../lib/imageFiles'
import { useStore } from '../../../store'
import { useTheme } from '../../../theme/useTheme'
import PlayBadge from '../../video/components/PlayBadge'
import type { CanvasEditor } from '../lib/editor'
import { importImageFiles } from '../lib/importImages'
import { ARROW_POINTER, freedrawOutline } from '../lib/konvaShapes'
import { type NodeCanvasDocument, openNodeCanvasDocument } from '../lib/nodeCanvasDocument'
import { composeNodePrompt, incomingReferences, referenceFileIds } from '../lib/nodeCanvasFlow'
import { fillImageNode, resumeNodeGenerations, submitNodeImage } from '../lib/nodeCanvasGenerate'
import { commitNodeText, placeEmptyImageNode, placeNodeText } from '../lib/nodeCanvasPlace'
import type { CanvasWorkspace } from '../lib/workspaces'
import CanvasVideoPlayer from './CanvasVideoPlayer'
import NodeAddMenu from './NodeAddMenu'
import NodeComposer from './NodeComposer'

type FlowNode = Node<{ node?: CanvasNode; annotation?: CanvasAnnotation }>
const legacyOrigin = canvasOrigin('system', 'legacy-update')

/** 位图仍在旧存档的 `files` 里（fileId → dataUrl）；节点只存引用。 */
const FilesContext = createContext<Readonly<Record<string, string>>>({})

/** 内容没变的项沿用上一份的对象，下游的 `memo` 才认得出「没变」。 */
function keepUnchanged<T extends { id: string }>(previous: readonly T[], next: T[]): T[] {
  const before = new Map(previous.map((item) => [item.id, item]))
  let same = previous.length === next.length
  const merged = next.map((item, index) => {
    const old = before.get(item.id)
    if (old && JSON.stringify(old) === JSON.stringify(item)) {
      if (previous[index] !== old) same = false
      return old
    }
    same = false
    return item
  })
  return same ? (previous as T[]) : merged
}

function useDocumentSnapshot(canvas: NodeCanvasDocument): CanvasSnapshot {
  const [store] = useState(() => {
    let snapshot = readCanvasDocument(canvas.doc)
    return {
      subscribe(listener: () => void) {
        const onUpdate = () => {
          const next = readCanvasDocument(canvas.doc)
          snapshot = {
            nodes: keepUnchanged(snapshot.nodes, next.nodes),
            annotations: keepUnchanged(snapshot.annotations, next.annotations),
            edges: keepUnchanged(snapshot.edges, next.edges),
          }
          listener()
        }
        canvas.doc.on('update', onUpdate)
        return () => canvas.doc.off('update', onUpdate)
      },
      get: () => snapshot,
    }
  })
  return useSyncExternalStore(store.subscribe, store.get)
}

function toFlowNode(node: CanvasNode, selected: boolean): FlowNode {
  return {
    id: node.id,
    type: node.type,
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    zIndex: node.z,
    selected,
    data: { node },
  }
}

/** 左右两个加号：左边接上游，右边拉到下一个节点。 */
function NodePorts() {
  const { t } = useTranslation('canvas')
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="studio-node-handle"
        aria-label={t('nodes.connectIn')}
      >
        <Icon name="add" size="xs" className="pointer-events-none" />
      </Handle>
      <Handle
        type="source"
        position={Position.Right}
        className="studio-node-handle"
        aria-label={t('nodes.connectOut')}
      >
        <Icon name="add" size="xs" className="pointer-events-none" />
      </Handle>
    </>
  )
}

function Pending({ pending }: { pending: PendingGeneration }) {
  const { t } = useTranslation('canvas')
  const status =
    pending.type === 'generation' ? (pending.errorCode ? 'error' : 'loading') : pending.status
  const label =
    status === 'stale'
      ? t('placeholder.stale')
      : status === 'error'
        ? t('placeholder.failed')
        : t('placeholder.generating')
  return (
    <div className="studio-node-pending text-sm" data-failed={status !== 'loading' || undefined}>
      {label}
    </div>
  )
}

function Picture({ fileId, rotation }: { fileId?: string; rotation?: number }) {
  const { t } = useTranslation('canvas')
  const files = useContext(FilesContext)
  const source = fileId ? files[fileId] : undefined
  if (!source) return <div className="studio-node-missing text-sm">{t('nodes.mediaMissing')}</div>
  return (
    <img
      src={source}
      alt=""
      draggable={false}
      className="studio-node-media"
      // 旧画布绕左上角旋转，节点框按未旋转的尺寸摆。
      style={rotation ? { transform: `rotate(${rotation}deg)`, transformOrigin: '0 0' } : undefined}
    />
  )
}

const ImageNode = memo(function ImageNode({ data: { node } }: NodeProps<FlowNode>) {
  if (node?.type !== 'image') return null
  const { pending, fileId, rotation } = node.data
  return (
    <>
      <NodePorts />
      <div className="studio-node studio-node--image" data-rotated={rotation ? true : undefined}>
        {pending ? (
          <Pending pending={pending} />
        ) : fileId ? (
          <Picture fileId={fileId} rotation={rotation} />
        ) : (
          <div className="studio-node-empty">
            <Icon name="image" size="lg" />
          </div>
        )}
      </div>
    </>
  )
})

const VideoNode = memo(function VideoNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const files = useContext(FilesContext)
  const [playing, setPlaying] = useState(false)
  if (node?.type !== 'video') return null
  const { fileId, rotation, video } = node.data
  if (playing)
    return (
      <>
        <NodePorts />
        <div
          className="studio-node studio-node--video nodrag nopan"
          data-rotated={rotation ? true : undefined}
        >
          <div
            className="h-full w-full"
            style={
              rotation ? { transform: `rotate(${rotation}deg)`, transformOrigin: '0 0' } : undefined
            }
          >
            <CanvasVideoPlayer
              src={queueOutputUrl(video.taskId, video.outputIndex)}
              poster={fileId ? files[fileId] : undefined}
              onEnded={() => setPlaying(false)}
            />
          </div>
        </div>
      </>
    )
  return (
    <>
      <NodePorts />
      <div className="studio-node studio-node--video" data-rotated={rotation ? true : undefined}>
        <Picture fileId={fileId} rotation={rotation} />
        <Button
          variant="ghost"
          size="icon"
          className="studio-node-play nodrag h-auto w-auto rounded-full p-0 hover:bg-transparent"
          aria-label={t('videoOverlay.play')}
          onClick={() => setPlaying(true)}
        >
          <PlayBadge />
        </Button>
      </div>
    </>
  )
})

const TextNode = memo(function TextNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  if (node?.type !== 'text') return null
  const { text, fontSize, fill } = node.data
  return (
    <>
      <NodePorts />
      <div
        className="studio-node studio-node--text"
        style={text ? { fontSize, color: fill } : { fontSize }}
      >
        {text || <span className="text-sm text-muted-foreground">{t('nodes.addText')}</span>}
      </div>
    </>
  )
})

const TimelineNode = memo(function TimelineNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  if (node?.type !== 'timeline') return null
  return (
    <div className="studio-node studio-node--timeline text-sm">
      <Icon name="video" />
      {t('nodes.timeline', { count: node.data.clips.length })}
    </div>
  )
})

/** 箭头头部：与旧画布 Konva 箭头同一份尺寸，填充并描边成同色三角。 */
function arrowHead(points: readonly number[]): string {
  const [x1, y1, x2, y2] = points.slice(-4) as [number, number, number, number]
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const back = (side: number) => {
    const bx = x2 - ARROW_POINTER.length * Math.cos(angle)
    const by = y2 - ARROW_POINTER.length * Math.sin(angle)
    const half = (ARROW_POINTER.width / 2) * side
    return `${bx - half * Math.sin(angle)},${by + half * Math.cos(angle)}`
  }
  return `${x2},${y2} ${back(1)} ${back(-1)}`
}

const AnnotationNode = memo(function AnnotationNode({
  data: { annotation: one },
}: NodeProps<FlowNode>) {
  if (!one) return null
  const bounds = annotationBounds(one)
  return (
    // design-allow inline-svg: 这是标注的绘制层，不是图标
    <svg
      className="studio-node-annotations"
      aria-hidden="true"
      viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
      width={bounds.width}
      height={bounds.height}
    >
      {one.type === 'freedraw' ? (
        <polygon key={one.id} points={freedrawOutline(one).join(' ')} fill={one.stroke} />
      ) : (
        <g key={one.id} stroke={one.stroke} strokeWidth={one.strokeWidth}>
          <polyline points={one.points.join(' ')} fill="none" strokeLinecap="round" />
          {/* 与 Konva 一致：尖角连接、canvas 默认的斜接上限 10，头部才和旧画布一样大。 */}
          <polygon points={arrowHead(one.points)} fill={one.stroke} strokeMiterlimit={10} />
        </g>
      )}
    </svg>
  )
})

const nodeTypes = {
  image: ImageNode,
  video: VideoNode,
  text: TextNode,
  timeline: TimelineNode,
  annotation: AnnotationNode,
}

function annotationBounds(annotation: CanvasAnnotation): Rect {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let i = 0; i + 1 < annotation.points.length; i += 2) {
    const x = annotation.points[i]!
    const y = annotation.points[i + 1]!
    if (Number.isFinite(x) && Number.isFinite(y)) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 }
  const pad = annotation.strokeWidth + (annotation.type === 'arrow' ? ARROW_POINTER.length : 0)
  const x = minX - pad
  const y = minY - pad
  return { x, y, width: Math.max(1, maxX + pad - x), height: Math.max(1, maxY + pad - y) }
}

function toAnnotationNode(annotation: CanvasAnnotation): FlowNode {
  const bounds = annotationBounds(annotation)
  return {
    id: annotation.id,
    type: 'annotation',
    position: { x: bounds.x, y: bounds.y },
    width: bounds.width,
    height: bounds.height,
    zIndex: annotation.z,
    draggable: false,
    selectable: false,
    focusable: false,
    data: { annotation },
  }
}

/** 节点与标注的总范围：只框节点的话，只有笔迹的旧项目一打开是空白。 */
function contentBounds({ nodes, annotations }: CanvasSnapshot): Rect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const include = (left: number, top: number, right: number, bottom: number) => {
    // 坏数据（NaN、奇数长度的点列）跳过，免得一个坏点把整个视野带歪。
    if (![left, top, right, bottom].every(Number.isFinite)) return
    minX = Math.min(minX, left)
    minY = Math.min(minY, top)
    maxX = Math.max(maxX, right)
    maxY = Math.max(maxY, bottom)
  }
  for (const node of nodes) include(node.x, node.y, node.x + node.width, node.y + node.height)
  for (const one of annotations) {
    const bounds = annotationBounds(one)
    include(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function Flow({
  canvas,
  container,
  editor,
  active,
}: {
  canvas: NodeCanvasDocument
  container: RefObject<HTMLDivElement | null>
  editor: CanvasEditor
  active: boolean
}) {
  const { t } = useTranslation('canvas')
  const snapshot = useDocumentSnapshot(canvas)
  const { theme } = useTheme()
  const files = useContext(FilesContext)
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [fileOver, setFileOver] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [frame, setFrame] = useState({ x: 0, y: 0, zoom: 1, width: 0, height: 0 })
  const [draftVersion, setDraftVersion] = useState(0)
  const drafts = useRef(new Map<string, string>())
  const selectedRef = useRef<string | null>(null)
  const flowRef = useRef<{
    screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number }
    setViewport: (viewport: { x: number; y: number; zoom: number }) => void
    getViewport: () => { x: number; y: number; zoom: number }
  } | null>(null)
  const placeAt = useRef({ x: 0, y: 0 })
  const fileInput = useRef<HTMLInputElement>(null)
  const fileDepth = useRef(0)
  const closeMenu = () => setMenu(null)
  const remember = (viewport: { x: number; y: number; zoom: number }) => {
    const box = container.current
    setFrame({
      x: viewport.x,
      y: viewport.y,
      zoom: viewport.zoom || 1,
      width: box?.clientWidth ?? 0,
      height: box?.clientHeight ?? 0,
    })
  }
  const finishNode = (id: string) => {
    const current = readCanvasDocument(canvas.doc)
    const node = current.nodes.find((one) => one.id === id)
    if (!node) return
    if (node.type === 'text') {
      const raw = drafts.current.get(id)
      if (raw !== undefined && (raw !== node.data.text || !raw.trim()))
        commitNodeText(editor, id, raw)
      drafts.current.delete(id)
      return
    }
    if (node.type !== 'image' || node.data.fileId || node.data.pending) return
    if (drafts.current.get(id)?.trim()) return
    if (current.edges.some((edge) => edge.source === id || edge.target === id)) return
    deleteCanvasNode(canvas.doc, id, canvas.origin)
    drafts.current.delete(id)
  }
  const selectNode = (next: string | null) => {
    const current = selectedRef.current
    if (current && current !== next) finishNode(current)
    if (next) {
      const node = readCanvasDocument(canvas.doc).nodes.find((one) => one.id === next)
      if (node?.type === 'text' && !drafts.current.has(next))
        drafts.current.set(next, node.data.text)
    }
    selectedRef.current = next
    setSelectedId(next)
  }
  const textFill = theme === 'dark' ? '#f4f4f5' : '#18181b'
  const placeFiles = (files: File[]) => {
    const images = acceptImageFiles(files)
    if (images.length === 0) return
    const point = placeAt.current
    confirmImageBatch(images.length, () => {
      void importImageFiles(editor, images, point).catch(() =>
        useStore.getState().showToast(t('import.failed'), 'error'),
      )
    })
  }
  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((one) => [one.id, one]))
      const media = snapshot.nodes.map((node) => {
        const old = previous.get(node.id)
        const selected = node.id === selectedId
        return old?.data.node === node && old.selected === selected
          ? old
          : toFlowNode(node, selected)
      })
      return [
        ...media,
        ...snapshot.annotations.map((annotation) => {
          const old = previous.get(annotation.id)
          return old?.data.annotation === annotation ? old : toAnnotationNode(annotation)
        }),
      ]
    })
  }, [snapshot, selectedId])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active || event.defaultPrevented) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.isContentEditable || target?.closest('input, textarea, [contenteditable]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      if (event.shiftKey) canvas.undo.redo()
      else canvas.undo.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvas, active])
  useEffect(() => {
    const el = container.current
    if (!el) return
    const flowPoint = (event: { clientX: number; clientY: number }) =>
      flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const onDoubleClick = (event: MouseEvent) => {
      if (!active) return
      const target = event.target instanceof Element ? event.target : null
      if (
        target?.closest(
          '.react-flow__node, .react-flow__controls, .react-flow__minimap, .react-flow__handle, .studio-node-menu, .studio-node-composer, textarea, input',
        )
      )
        return
      const point = flowPoint(event)
      if (!point) return
      event.preventDefault()
      placeAt.current = point
      setMenu({ x: event.clientX, y: event.clientY })
    }
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      fileDepth.current += 1
      setFileOver(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    const onDragLeave = () => {
      if (fileDepth.current === 0) return
      fileDepth.current -= 1
      if (fileDepth.current <= 0) setFileOver(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return
      event.preventDefault()
      fileDepth.current = 0
      setFileOver(false)
      const point = flowPoint(event)
      if (!point) return
      placeAt.current = point
      // collectDroppedFiles 必须在这一拍同步调用：await 之后 DataTransfer.items 就空了。
      void collectDroppedFiles(event.dataTransfer).then(({ files }) => placeFiles(files))
    }
    el.addEventListener('dblclick', onDoubleClick, true)
    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dblclick', onDoubleClick, true)
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [active, editor, t])
  const selected = nodes.find((one) => one.id === selectedId)
  const composerNode =
    selected?.data.node &&
    (selected.data.node.type === 'image' || selected.data.node.type === 'text')
      ? selected.data.node
      : undefined
  const references = composerNode
    ? incomingReferences(snapshot.nodes, snapshot.edges, composerNode.id)
    : []
  const draftValue = composerNode
    ? (drafts.current.get(composerNode.id) ??
      (composerNode.type === 'text' ? composerNode.data.text : ''))
    : ''
  const busy =
    composerNode?.type === 'image' && composerNode.data.pending
      ? composerNode.data.pending.type === 'generation'
        ? !composerNode.data.pending.errorCode
        : composerNode.data.pending.status === 'loading'
      : false
  const composerAt = composerNode && selected ? composerAnchor(selected, frame) : null
  void draftVersion
  return (
    <>
      <ReactFlow<FlowNode>
        nodes={nodes}
        edges={snapshot.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        }))}
        nodeTypes={nodeTypes}
        zoomOnDoubleClick={false}
        elevateNodesOnSelect={false}
        onNodesChange={(changes: NodeChange<FlowNode>[]) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onNodeClick={(_event, node) => {
          if (node.data.node && (node.type === 'image' || node.type === 'text')) selectNode(node.id)
        }}
        onPaneClick={() => selectNode(null)}
        onConnect={(connection) => {
          if (!connection.source || !connection.target) return
          connectCanvasNodes(
            canvas.doc,
            { source: connection.source, target: connection.target },
            canvas.origin,
          )
        }}
        isValidConnection={(connection) =>
          Boolean(connection.source && connection.target && connection.source !== connection.target)
        }
        onNodeDragStop={(_event, _node, dragged) =>
          moveCanvasNodes(
            canvas.doc,
            dragged
              .filter((one) => one.data.node)
              .map((one) => ({ id: one.id, x: one.position.x, y: one.position.y })),
            canvas.origin,
          )
        }
        onMove={(_event, viewport) => remember(viewport)}
        colorMode={theme}
        minZoom={0.05}
        maxZoom={8}
        onInit={(flow) => {
          flowRef.current = flow
          const bounds = contentBounds(snapshot)
          const box = container.current
          // 容器还没量出尺寸时留默认视口，免得按 0 宽高缩到最小。
          if (bounds && box?.clientWidth && box.clientHeight) {
            // 与旧画布一致：打开时最多按 100% 显示。
            flow.setViewport(
              getViewportForBounds(bounds, box.clientWidth, box.clientHeight, 0.05, 1, 0.1),
            )
          }
          remember(flow.getViewport())
        }}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
      {fileOver && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/70 backdrop-blur-[2px]">
          <span className="rounded-lg bg-card px-3 py-1.5 text-sm font-medium shadow-md">
            {t('drop.hint')}
          </span>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          placeFiles(files)
        }}
      />
      {menu && (
        <NodeAddMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onText={() => {
            const id = placeNodeText(editor, placeAt.current, textFill)
            closeMenu()
            selectNode(id)
          }}
          onImage={() => {
            const id = placeEmptyImageNode(canvas.doc, placeAt.current)
            closeMenu()
            selectNode(id)
          }}
          onUpload={() => {
            closeMenu()
            fileInput.current?.click()
          }}
        />
      )}
      {composerNode && composerAt && (
        <NodeComposer
          node={composerNode}
          references={references}
          files={files}
          value={draftValue}
          busy={busy}
          position={composerAt}
          onChange={(value) => {
            drafts.current.set(composerNode.id, value)
            setDraftVersion((version) => version + 1)
          }}
          onSubmit={() => {
            const value = drafts.current.get(composerNode.id) ?? ''
            if (composerNode.type === 'text') {
              commitNodeText(editor, composerNode.id, value)
              drafts.current.delete(composerNode.id)
              if (!value.trim()) selectNode(null)
              return
            }
            const urls = referenceFileIds(references).flatMap((id) => {
              const source = files[id]
              return source ? [source] : []
            })
            submitNodeImage(
              editor,
              canvas.doc,
              composerNode.id,
              composeNodePrompt(value, references),
              urls,
            )
          }}
          onUploadFile={(file) => {
            void fillImageNode(editor, canvas.doc, composerNode.id, file).catch(() =>
              useStore.getState().showToast(t('import.failed'), 'error'),
            )
          }}
        />
      )}
    </>
  )
}

/** 输入框不跟着缩放，贴在节点底边的正下方，并留在容器里面。 */
function composerAnchor(
  node: FlowNode,
  frame: { x: number; y: number; zoom: number; width: number; height: number },
): { left: number; top: number } {
  const zoom = frame.zoom || 1
  const width = node.width ?? 0
  const height = node.height ?? 0
  const center = node.position.x * zoom + frame.x + (width * zoom) / 2
  const rawTop = node.position.y * zoom + frame.y + height * zoom + 12
  if (frame.width <= 0) return { left: center, top: rawTop }
  const panel = Math.min(560, Math.max(280, frame.width - 24))
  const limit = Math.max(panel / 2 + 12, frame.width - panel / 2 - 12)
  return {
    left: Math.min(Math.max(center, panel / 2 + 12), limit),
    top: frame.height > 0 ? Math.min(rawTop, Math.max(12, frame.height - 220)) : rawTop,
  }
}

/** 节点画布（`canvas:nodes`）：一个项目的 `Y.Doc` 渲染成 React Flow。 */
export default function NodeCanvas({
  workspace,
  active,
}: {
  workspace: CanvasWorkspace
  active: boolean
}) {
  const { t } = useTranslation('canvas')
  const files = useSyncExternalStore(workspace.doc.subscribe, () => workspace.doc.files)
  const [canvas, setCanvas] = useState<NodeCanvasDocument | null>(null)
  const [failed, setFailed] = useState(false)
  const key = workspace.record.key
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    let opened: NodeCanvasDocument | undefined
    let previous = workspace.doc.elements as readonly LegacyCanvasElement[]
    const queued: Array<readonly [readonly LegacyCanvasElement[], readonly LegacyCanvasElement[]]> =
      []
    const unsubscribe = workspace.doc.subscribe(() => {
      const next = workspace.doc.elements as readonly LegacyCanvasElement[]
      if (opened && alive) synchronizeLegacyElements(opened.doc, previous, next, legacyOrigin)
      else if (alive && previous !== next) queued.push([previous, next])
      previous = next
    })
    setCanvas(null)
    setFailed(false)
    openNodeCanvasDocument(key, () => workspace.doc.elements as readonly LegacyCanvasElement[])
      .then((one) => {
        if (!alive) {
          void one.destroy()
          return
        }
        opened = one
        reconcileLegacyElements(one.doc, previous, legacyOrigin)
        // 迁移可能读过中间状态；逐次重放也能接住「添加后撤销」这类净差异为零的变化。
        for (const [before, after] of queued)
          synchronizeLegacyElements(one.doc, before, after, legacyOrigin)
        queued.length = 0
        resumeNodeGenerations(workspace.editor, one.doc)
        setCanvas(one)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      unsubscribe()
      void opened?.destroy()
    }
  }, [key, workspace])
  // 位图表一变整个组件就重渲染；挡住它，免得每加一张图都把整块 React Flow 重画一遍。
  const content = useMemo(
    () =>
      canvas && (
        <ReactFlowProvider>
          <Flow canvas={canvas} container={container} editor={workspace.editor} active={active} />
        </ReactFlowProvider>
      ),
    [canvas, active, workspace.editor],
  )
  if (failed)
    return (
      <p role="alert" className="studio-node-canvas-error text-sm">
        {t('nodes.loadFailed')}
      </p>
    )
  return (
    <FilesContext.Provider value={files}>
      <div ref={container} className="studio-node-canvas">
        {content}
      </div>
    </FilesContext.Provider>
  )
}
