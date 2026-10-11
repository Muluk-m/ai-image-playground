import {
  type CanvasAnnotation,
  type CanvasNode,
  type CanvasSnapshot,
  type LegacyCanvasElement,
  moveCanvasNodes,
  readCanvasDocument,
} from '@image-playground/shared'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type ColorMode,
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
import { getTheme, subscribeTheme } from '../../../theme'
import { type NodeCanvasDocument, openNodeCanvasDocument } from '../lib/nodeCanvasDocument'
import type { CanvasWorkspace } from '../lib/workspaces'

type FlowNode = Node<{ node: CanvasNode }>

/** 位图仍在旧存档的 `files` 里（fileId → dataUrl）；节点只存引用。 */
const FilesContext = createContext<Readonly<Record<string, string>>>({})

function useDocumentSnapshot(canvas: NodeCanvasDocument): CanvasSnapshot {
  const [store] = useState(() => {
    let snapshot = readCanvasDocument(canvas.doc)
    return {
      subscribe(listener: () => void) {
        const onUpdate = () => {
          snapshot = readCanvasDocument(canvas.doc)
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

function useColorMode(): ColorMode {
  return useSyncExternalStore(subscribeTheme, getTheme)
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

function Pending({ pending }: { pending: Record<string, unknown> }) {
  const { t } = useTranslation('canvas')
  const failed = pending.status === 'error' || pending.status === 'stale' || 'errorCode' in pending
  return (
    <div className="studio-node-pending text-sm" data-failed={failed || undefined}>
      {failed ? t('nodes.failed') : t('nodes.generating')}
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

const ImageNode = memo(function ImageNode({ data }: NodeProps<FlowNode>) {
  const { pending, fileId, rotation } = data.node.data as {
    pending?: Record<string, unknown>
    fileId?: string
    rotation?: number
  }
  return (
    <div className="studio-node studio-node--image" data-rotated={rotation ? true : undefined}>
      {pending ? <Pending pending={pending} /> : <Picture fileId={fileId} rotation={rotation} />}
    </div>
  )
})

const VideoNode = memo(function VideoNode({ data }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const [playing, setPlaying] = useState(false)
  const { fileId, rotation, video } = data.node.data as {
    fileId?: string
    rotation?: number
    video?: { taskId: string; outputIndex: number }
  }
  if (playing && video)
    return (
      <div className="studio-node studio-node--video nodrag nopan">
        <video
          className="studio-node-media studio-node-player"
          src={queueOutputUrl(video.taskId, video.outputIndex)}
          controls
          autoPlay
          playsInline
        />
      </div>
    )
  return (
    <div
      className="studio-node studio-node--video"
      data-rotated={rotation ? true : undefined}
      aria-label={t('nodes.video')}
    >
      <Picture fileId={fileId} rotation={rotation} />
      {video && (
        <Button
          variant="ghost"
          size="icon"
          className="studio-node-badge nodrag size-8 rounded-full bg-foreground/60 text-background hover:bg-foreground/75 hover:text-background"
          aria-label={t('videoOverlay.play')}
          onClick={() => setPlaying(true)}
        >
          <Icon name="play" size="xs" />
        </Button>
      )}
    </div>
  )
})

const TextNode = memo(function TextNode({ data }: NodeProps<FlowNode>) {
  const { text, fontSize, fill } = data.node.data as {
    text?: string
    fontSize?: number
    fill?: string
  }
  return (
    <div className="studio-node studio-node--text" style={{ fontSize, color: fill }}>
      {text}
    </div>
  )
})

const TimelineNode = memo(function TimelineNode({ data }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const clips = (data.node.data.clips as unknown[] | undefined) ?? []
  return (
    <div className="studio-node studio-node--timeline text-sm">
      <Icon name="timeline" />
      {t('nodes.timeline', { count: clips.length })}
    </div>
  )
})

const nodeTypes = { image: ImageNode, video: VideoNode, text: TextNode, timeline: TimelineNode }

/** 箭头头部：沿最后一段方向画实心三角，颜色跟线一致（marker 的 context-stroke 支持不稳）。 */
function arrowHead(points: readonly number[], width: number): string {
  const [x1, y1, x2, y2] = points.slice(-4)
  const angle = Math.atan2(y2! - y1!, x2! - x1!)
  const size = Math.max(width * 2.5, 12)
  const corner = (offset: number) =>
    `${x2! - size * Math.cos(angle + offset)},${y2! - size * Math.sin(angle + offset)}`
  return `${x2},${y2} ${corner(0.45)} ${corner(-0.45)}`
}

function Annotations({ annotations }: { annotations: readonly CanvasAnnotation[] }) {
  if (!annotations.length) return null
  return (
    <ViewportPortal>
      {/* design-allow inline-svg: 这是标注的绘制层，不是图标 */}
      <svg className="studio-node-annotations" aria-hidden="true">
        {annotations.map((one) => {
          const points = one.points
            .reduce<string[]>((pairs, value, index) => {
              if (index % 2 === 0) pairs.push(`${value},${one.points[index + 1]}`)
              return pairs
            }, [])
            .join(' ')
          return (
            <g key={one.id}>
              <polyline
                points={points}
                fill="none"
                stroke={one.stroke}
                strokeWidth={one.strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {one.type === 'arrow' && (
                <polygon points={arrowHead(one.points, one.strokeWidth)} fill={one.stroke} />
              )}
            </g>
          )
        })}
      </svg>
    </ViewportPortal>
  )
}

function Flow({ canvas }: { canvas: NodeCanvasDocument }) {
  const snapshot = useDocumentSnapshot(canvas)
  const colorMode = useColorMode()
  const [nodes, setNodes] = useState<FlowNode[]>([])
  useEffect(() => {
    setNodes((current) => {
      const selected = new Set(current.filter((one) => one.selected).map((one) => one.id))
      return snapshot.nodes.map((node) => toFlowNode(node, selected.has(node.id)))
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
      colorMode={colorMode}
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
  const content = useMemo(
    () =>
      canvas && (
        <ReactFlowProvider>
          <Flow key={key} canvas={canvas} />
        </ReactFlowProvider>
      ),
    [canvas, key],
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
