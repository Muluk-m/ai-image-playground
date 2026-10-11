import {
  type CanvasAnnotation,
  type CanvasNode,
  type CanvasSnapshot,
  type LegacyCanvasElement,
  moveCanvasNodes,
  type PendingGeneration,
  readCanvasDocument,
} from '@image-playground/shared'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import { useTheme } from '../../../theme/useTheme'
import PlayBadge from '../../video/components/PlayBadge'
import { ARROW_POINTER, freedrawOutline } from '../lib/konvaShapes'
import { type NodeCanvasDocument, openNodeCanvasDocument } from '../lib/nodeCanvasDocument'
import type { CanvasWorkspace } from '../lib/workspaces'
import CanvasVideoPlayer from './CanvasVideoPlayer'

type FlowNode = Node<{ node: CanvasNode }>

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
  if (node.type !== 'image') return null
  const { pending, fileId, rotation } = node.data
  return (
    <div className="studio-node studio-node--image" data-rotated={rotation ? true : undefined}>
      {pending ? <Pending pending={pending} /> : <Picture fileId={fileId} rotation={rotation} />}
    </div>
  )
})

const VideoNode = memo(function VideoNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const files = useContext(FilesContext)
  const [playing, setPlaying] = useState(false)
  if (node.type !== 'video') return null
  const { fileId, rotation, video } = node.data
  if (playing)
    return (
      <div className="studio-node studio-node--video nodrag nopan">
        <CanvasVideoPlayer
          src={queueOutputUrl(video.taskId, video.outputIndex)}
          poster={fileId ? files[fileId] : undefined}
          onEnded={() => setPlaying(false)}
        />
      </div>
    )
  return (
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
  )
})

const TextNode = memo(function TextNode({ data: { node } }: NodeProps<FlowNode>) {
  if (node.type !== 'text') return null
  const { text, fontSize, fill } = node.data
  return (
    <div className="studio-node studio-node--text" style={{ fontSize, color: fill }}>
      {text}
    </div>
  )
})

const TimelineNode = memo(function TimelineNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  if (node.type !== 'timeline') return null
  return (
    <div className="studio-node studio-node--timeline text-sm">
      <Icon name="timeline" />
      {t('nodes.timeline', { count: node.data.clips.length })}
    </div>
  )
})

const nodeTypes = { image: ImageNode, video: VideoNode, text: TextNode, timeline: TimelineNode }

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

const Annotations = memo(function Annotations({
  annotations,
}: {
  annotations: readonly CanvasAnnotation[]
}) {
  if (!annotations.length) return null
  return (
    <ViewportPortal>
      {/* design-allow inline-svg: 这是标注的绘制层，不是图标 */}
      <svg className="studio-node-annotations" aria-hidden="true">
        {annotations.map((one) =>
          one.type === 'freedraw' ? (
            <polygon key={one.id} points={freedrawOutline(one).join(' ')} fill={one.stroke} />
          ) : (
            <g key={one.id} stroke={one.stroke} strokeWidth={one.strokeWidth}>
              <polyline points={one.points.join(' ')} fill="none" strokeLinecap="round" />
              {/* 与 Konva 一致：尖角连接、canvas 默认的斜接上限 10，头部才和旧画布一样大。 */}
              <polygon points={arrowHead(one.points)} fill={one.stroke} strokeMiterlimit={10} />
            </g>
          ),
        )}
      </svg>
    </ViewportPortal>
  )
})

function Flow({ canvas }: { canvas: NodeCanvasDocument }) {
  const snapshot = useDocumentSnapshot(canvas)
  const { theme } = useTheme()
  const [nodes, setNodes] = useState<FlowNode[]>([])
  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((one) => [one.id, one]))
      return snapshot.nodes.map((node) => {
        const old = previous.get(node.id)
        return old?.data.node === node ? old : toFlowNode(node, old?.selected ?? false)
      })
    })
  }, [snapshot])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      if (event.shiftKey) canvas.undo.redo()
      else canvas.undo.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvas])
  return (
    <ReactFlow<FlowNode>
      nodes={nodes}
      nodeTypes={nodeTypes}
      onNodesChange={(changes: NodeChange<FlowNode>[]) =>
        setNodes((current) => applyNodeChanges(changes, current))
      }
      onNodeDragStop={(_event, _node, dragged) =>
        moveCanvasNodes(
          canvas.doc,
          dragged.map((one) => ({ id: one.id, x: one.position.x, y: one.position.y })),
          canvas.origin,
        )
      }
      colorMode={theme}
      minZoom={0.05}
      maxZoom={8}
      fitView
      fitViewOptions={{ maxZoom: 1 }}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
    >
      <Annotations annotations={snapshot.annotations} />
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

/** 节点画布（`canvas:nodes`）：一个项目的 `Y.Doc` 渲染成 React Flow。 */
export default function NodeCanvas({ workspace }: { workspace: CanvasWorkspace }) {
  const { t } = useTranslation('canvas')
  const files = useSyncExternalStore(workspace.doc.subscribe, () => workspace.doc.files)
  const [canvas, setCanvas] = useState<NodeCanvasDocument | null>(null)
  const [failed, setFailed] = useState(false)
  const key = workspace.record.key
  useEffect(() => {
    let alive = true
    let opened: NodeCanvasDocument | undefined
    setCanvas(null)
    setFailed(false)
    openNodeCanvasDocument(
      key,
      () => workspace.doc.elements as readonly LegacyCanvasElement[],
    ).then(
      (one) => {
        opened = one
        if (alive) setCanvas(one)
        else void one.destroy()
      },
      () => alive && setFailed(true),
    )
    return () => {
      alive = false
      void opened?.destroy()
    }
  }, [key, workspace])
  // 位图表一变整个组件就重渲染；挡住它，免得每加一张图都把整块 React Flow 重画一遍。
  const content = useMemo(
    () =>
      canvas && (
        <ReactFlowProvider>
          <Flow canvas={canvas} />
        </ReactFlowProvider>
      ),
    [canvas],
  )
  if (failed)
    return (
      <p role="alert" className="studio-node-canvas-error text-sm">
        {t('nodes.loadFailed')}
      </p>
    )
  return (
    <FilesContext.Provider value={files}>
      <div className="studio-node-canvas">{content}</div>
    </FilesContext.Provider>
  )
}
