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
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
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
  const read = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  const [mode, setMode] = useState<ColorMode>(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return mode
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
    <div className="studio-node studio-node--image">
      {pending ? <Pending pending={pending} /> : <Picture fileId={fileId} rotation={rotation} />}
    </div>
  )
})

const VideoNode = memo(function VideoNode({ data }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const { fileId } = data.node.data as { fileId?: string }
  return (
    <div className="studio-node studio-node--video" aria-label={t('nodes.video')}>
      <Picture fileId={fileId} />
      <span className="studio-node-badge bg-foreground/60 text-background">
        <Icon name="play" size="xs" />
      </span>
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

function Annotations({ annotations }: { annotations: readonly CanvasAnnotation[] }) {
  if (!annotations.length) return null
  return (
    <ViewportPortal>
      {/* design-allow inline-svg: 这是标注的绘制层，不是图标 */}
      <svg className="studio-node-annotations" aria-hidden="true">
        <defs>
          <marker
            id="studio-node-arrowhead"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="4"
            markerHeight="4"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
          </marker>
        </defs>
        {annotations.map((one) => {
          const points = one.points
            .reduce<string[]>((pairs, value, index) => {
              if (index % 2 === 0) pairs.push(`${value},${one.points[index + 1]}`)
              return pairs
            }, [])
            .join(' ')
          return (
            <polyline
              key={one.id}
              points={points}
              fill="none"
              stroke={one.stroke}
              strokeWidth={one.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              markerEnd={one.type === 'arrow' ? 'url(#studio-node-arrowhead)' : undefined}
            />
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
        else one.destroy()
      },
      () => alive && setFailed(true),
    )
    return () => {
      alive = false
      opened?.destroy()
    }
  }, [key, workspace])
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
