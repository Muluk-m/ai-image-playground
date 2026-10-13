import {
  type CanvasAnnotation,
  type CanvasGroup,
  type CanvasNode,
  type CanvasSnapshot,
  canvasConnectionAllowed,
  canvasKindsConnect,
  canvasLinkAllowed,
  canvasOrigin,
  canvasResults,
  connectCanvasNodes,
  createCanvasGroup,
  disconnectCanvasNodes,
  type LegacyCanvasElement,
  moveCanvasGroups,
  moveCanvasNodes,
  type PendingGeneration,
  readCanvasDocument,
  reconcileCanvasGroupMembership,
  reconcileLegacyElements,
  renameCanvasGroup,
  synchronizeLegacyElements,
  ungroupCanvasNodes,
  updateCanvasNode,
} from '@image-playground/shared'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  getViewportForBounds,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  NodeResizer,
  ReactFlow,
  ReactFlowProvider,
  type Rect,
  SelectionMode,
} from '@xyflow/react'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { useNodeMedia } from './NodeMediaImage'
import '@xyflow/react/dist/style.css'
import {
  createContext,
  lazy,
  memo,
  type RefObject,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ImagePreview } from '../../../components/Lightbox'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import { safeLocalStorage, scopedStorageName } from '../../../lib/authScope'
import { videoOutputUrl } from '../../../lib/channels/queueClient'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { downloadBlob } from '../../../lib/downloadImages'
import { acceptImageFiles, collectDroppedFiles } from '../../../lib/imageFiles'
import { useStore } from '../../../store'
import { useTheme } from '../../../theme/useTheme'
import { useLibraryStore } from '../../library/store'
import type { AssetRecord } from '../../library/types'
import PlayBadge from '../../video/components/PlayBadge'
import { arrangementKey, arrangeNodes, type CanvasPlacement } from '../lib/arrangeNodes'
import { newElementId } from '../lib/canvasDoc'
import type { CanvasEditor } from '../lib/editor'
import { ARROW_POINTER, freedrawOutline } from '../lib/konvaShapes'
import { assetNodeContext } from '../lib/nodeAssetGeneration'
import { ASSET_DRAG_TYPE, insertAssetNode, saveNodeAsAsset } from '../lib/nodeAssets'
import {
  type CreateNodeKind,
  copyNodes,
  createNode,
  nodeKind,
  pasteNodes,
  removeNodes,
} from '../lib/nodeCanvasActions'
import { type NodeCanvasDocument, openNodeCanvasDocument } from '../lib/nodeCanvasDocument'
import {
  composeNodePrompt,
  flowEdgeIds,
  incomingReferences,
  linkFromDrag,
  referenceFileIds,
} from '../lib/nodeCanvasFlow'
import { fillImageNode, resumeNodeGenerations, submitNodeImage } from '../lib/nodeCanvasGenerate'
import { TEXT_CARD_HEIGHT, TEXT_CARD_WIDTH } from '../lib/nodeCanvasPlace'
import { spreadNodeResults } from '../lib/nodeCanvasResults'
import { resumeNodeVideos, submitNodeVideo } from '../lib/nodeCanvasVideo'
import { projectNodeVideoEdits } from '../lib/nodeVideoTools'
import type { CanvasWorkspace } from '../lib/workspaces'
import CanvasVideoPlayer from './CanvasVideoPlayer'
import ImageNodeComposer from './ImageNodeComposer'
import NodeAddMenu from './NodeAddMenu'
import NodeAssetPicker from './NodeAssetPicker'
import NodeAssetTools from './NodeAssetTools'
import NodeCanvasToolbar, { NodeTool } from './NodeCanvasToolbar'
import NodeFlowEdge from './NodeFlowEdge'
import NodeGroup, { RenameGroupContext } from './NodeGroup'
import NodePorts, { SpawnContext } from './NodePorts'
import NodeReferenceEditor from './NodeReferenceEditor'
import NodeResultPicker from './NodeResultPicker'
import NodeSliceMenu from './NodeSliceMenu'
import NodeTextBody, { TextCanvasContext } from './NodeTextBody'
import NodeVideoTools, { NodeVideoPlayheadContext } from './NodeVideoTools'
import VideoNodeComposer from './VideoNodeComposer'

const NodeImageEditor = lazy(() => import('./NodeImageEditor'))

type FlowNode = Node<{ node?: CanvasNode; annotation?: CanvasAnnotation; group?: CanvasGroup }>
const edgeTypes = { reference: NodeFlowEdge }
const legacyOrigin = canvasOrigin('system', 'legacy-update')

/** 位图仍在旧存档的 `files` 里（fileId → dataUrl）；节点只存引用。 */
const FilesContext = createContext<Readonly<Record<string, string>>>({})
const FillImageContext = createContext<(id: string, file: File) => void>(() => {})
const EditNodeContext = createContext<
  (
    id: string,
    patch: { name?: string; width?: number; height?: number; x?: number; y?: number },
  ) => void
>(() => {})
const PreviewContext = createContext<(source: string) => void>(() => {})

function NodeCaption({ node }: { node: CanvasNode }) {
  const { t } = useTranslation('canvas')
  const update = useContext(EditNodeContext)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const kind = nodeKind(node)
  const label =
    'meta' in node.data && node.data.meta?.nodeKind === 'asset'
      ? t('nodes.assetNode')
      : kind === 'text'
        ? t('nodes.addText')
        : kind === 'video'
          ? t('nodes.addVideo')
          : t('nodes.addImage')
  const title = 'name' in node.data ? node.data.name : undefined
  return (
    <div className="studio-node-caption text-xs text-muted-foreground">
      <Icon
        name={
          'meta' in node.data && node.data.meta?.nodeKind === 'asset'
            ? 'layers'
            : kind === 'text'
              ? 'text'
              : kind === 'video'
                ? 'video'
                : 'image'
        }
        size="xs"
      />
      {editing ? (
        <Input
          className="nodrag nopan h-6 w-48 text-xs"
          autoFocus
          value={name}
          aria-label={t('nodes.rename')}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            update(node.id, { name: name.trim() })
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span
          className="truncate"
          onDoubleClick={(e) => {
            e.stopPropagation()
            setName(title ?? '')
            setEditing(true)
          }}
        >
          {title || label}
        </span>
      )}
      {node.type !== 'text' && 'naturalWidth' in node.data && node.data.naturalWidth && (
        <span className="ml-auto whitespace-nowrap opacity-60">
          {node.data.naturalWidth} × {node.data.naturalHeight}
        </span>
      )}
    </div>
  )
}
function NodeResize({ node, selected }: { node: CanvasNode; selected?: boolean }) {
  const update = useContext(EditNodeContext)
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={180}
      minHeight={120}
      keepAspectRatio={node.type !== 'text'}
      onResizeEnd={(_e, params) =>
        update(node.id, { x: params.x, y: params.y, width: params.width, height: params.height })
      }
    />
  )
}

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
            groups: keepUnchanged(snapshot.groups ?? [], next.groups ?? []),
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
  // 旧的短文本曾被量成两个字宽，加号会盖住正文。显示时至少给一张完整的卡。
  const width = node.type === 'text' ? Math.max(node.width, TEXT_CARD_WIDTH) : node.width
  const height = node.type === 'text' ? Math.max(node.height, TEXT_CARD_HEIGHT) : node.height
  return {
    id: node.id,
    type: nodeKind(node),
    position: { x: node.x, y: node.y },
    width,
    height,
    zIndex: node.z,
    selected,
    data: { node },
  }
}

function toGroupFlowNode(group: CanvasGroup, selected: boolean): FlowNode {
  return {
    id: group.id,
    type: 'canvasGroup',
    data: { group },
    position: { x: group.x, y: group.y },
    width: group.width,
    height: group.height,
    zIndex: -1,
    selected,
    dragHandle: '.studio-node-group-title',
  }
}

/** 拖线时连线盖在卡片上，取指针下真正的节点。 */
function nodeIdAtPoint(x: number, y: number): string | null {
  for (const hit of document.elementsFromPoint(x, y)) {
    const id = hit.closest('.react-flow__node')?.getAttribute('data-id')
    if (id) return id
  }
  return null
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
  const source = useNodeMedia(fileId ? files[fileId] : undefined)
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

const ImageNode = memo(function ImageNode({ data: { node }, selected }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const fillImage = useContext(FillImageContext)
  const preview = useContext(PreviewContext)
  const files = useContext(FilesContext)
  const uploadInput = useRef<HTMLInputElement>(null)
  if (node?.type !== 'image') return null
  const { pending, fileId, rotation } = node.data
  const empty = !pending && !fileId
  return (
    <>
      <NodePorts nodeId={node.id} />
      <NodeCaption node={node} />
      <NodeResize node={node} selected={selected} />
      {empty && selected && (
        <div className="studio-node-upload nodrag nopan">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={() => uploadInput.current?.click()}
          >
            <Icon name="upload" size="xs" />
            {t('nodes.addUpload')}
          </Button>
          <input
            ref={uploadInput}
            type="file"
            accept="image/*"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) fillImage(node.id, file)
            }}
          />
        </div>
      )}
      <div
        className="studio-node studio-node--image"
        data-rotated={rotation ? true : undefined}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (fileId && files[fileId]) preview(files[fileId])
        }}
      >
        {fileId ? (
          <Picture fileId={fileId} rotation={rotation} />
        ) : pending ? (
          <Pending pending={pending} />
        ) : (
          <div className="studio-node-empty">
            <Icon name={node.data.meta?.nodeKind === 'asset' ? 'layers' : 'image'} size="lg" />
            {node.data.meta?.nodeKind === 'asset' && (
              <div className="px-5 text-center">
                <p className="text-sm font-medium">{node.data.name}</p>
                <p className="mt-2 line-clamp-4 text-xs text-muted-foreground">
                  {node.data.meta.assetDescription}
                </p>
              </div>
            )}
          </div>
        )}
        {fileId && pending && (
          <div className="absolute inset-x-0 bottom-0 bg-background/80 py-2">
            <Pending pending={pending} />
          </div>
        )}
      </div>
    </>
  )
})

const VideoNode = memo(function VideoNode({ data: { node }, selected }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const files = useContext(FilesContext)
  const [playing, setPlaying] = useState(false)
  const playheads = useContext(NodeVideoPlayheadContext)
  const poster = useNodeMedia(
    node && 'fileId' in node.data && node.data.fileId ? files[node.data.fileId] : undefined,
  )
  if (!node || (node.type !== 'video' && node.type !== 'image')) return null
  const { fileId, rotation, pending } = node.data
  const video = node.type === 'video' ? node.data.video : undefined
  if (!video)
    return (
      <>
        <NodePorts nodeId={node.id} />
        <NodeCaption node={node} />
        <NodeResize node={node} selected={selected} />
        <div className="studio-node studio-node--video">
          {pending ? (
            <Pending pending={pending} />
          ) : (
            <div className="studio-node-empty">
              <Icon name="video" size="lg" />
            </div>
          )}
        </div>
      </>
    )
  if (playing)
    return (
      <>
        <NodePorts nodeId={node.id} />
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
              src={videoOutputUrl(video)}
              poster={poster}
              onEnded={() => setPlaying(false)}
              onTimeChange={(seconds) => playheads.set(node.id, seconds)}
            />
          </div>
        </div>
      </>
    )
  return (
    <>
      <NodePorts nodeId={node.id} />
      <NodeCaption node={node} />
      <NodeResize node={node} selected={selected} />
      <div className="studio-node studio-node--video" data-rotated={rotation ? true : undefined}>
        {fileId ? (
          <Picture fileId={fileId} rotation={rotation} />
        ) : (
          <div className="studio-node-empty">
            <Icon name="video" size="lg" />
          </div>
        )}
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

const TextNode = memo(function TextNode({ data: { node }, selected }: NodeProps<FlowNode>) {
  if (node?.type !== 'text') return null
  return (
    <>
      <NodePorts nodeId={node.id} />
      <NodeCaption node={node} />
      <NodeResize node={node} selected={selected} />
      <NodeTextBody nodeId={node.id} data={node.data} selected={selected} />
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
  canvasGroup: NodeGroup,
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
    // 标注只是叠在上面的笔迹。onNodeClick 会让 React Flow 打开指针事件，
    // 箭头的包围盒比笔画像素大，会挡住下面图片的拖动。
    style: { pointerEvents: 'none' },
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
  onChat,
  viewKey,
}: {
  viewKey: string
  onChat?: () => void
  canvas: NodeCanvasDocument
  container: RefObject<HTMLDivElement | null>
  editor: CanvasEditor
  active: boolean
}) {
  const { t } = useTranslation('canvas')
  const { t: common } = useTranslation('common')
  const snapshot = useDocumentSnapshot(canvas)
  const { theme } = useTheme()
  const files = useContext(FilesContext)
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [menu, setMenu] = useState<{
    x: number
    y: number
    anchorIds?: string[]
    side?: 'left' | 'right'
    nodeId?: string
    beside?: boolean
  } | null>(null)
  const [mode, setMode] = useState<'select' | 'pan'>('select')
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [addingAsset, setAddingAsset] = useState(false)
  const assetOperation = useRef(false)
  const [minimap, setMinimap] = useState(false)
  const [connections, setConnections] = useState(true)
  const [arrangement, setArrangement] = useState<{
    key: string
    positions: CanvasPlacement[]
    viewport: { x: number; y: number; zoom: number }
  } | null>(null)
  const layoutKey = useMemo(() => arrangementKey(snapshot), [snapshot])
  const arrangementActive = arrangement?.key === layoutKey
  const arrangementPositions = new Map(
    arrangementActive ? arrangement.positions.map((p) => [p.id, p]) : [],
  )
  const [imageEditId, setImageEditId] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const showPreview = (source: string) => {
    void resolveMediaSource(source, 'original', true)
      .then(setPreview)
      .catch(() => useStore.getState().showToast(t('nodes.mediaMissing'), 'error'))
  }
  const [videoPreview, setVideoPreview] = useState<{ src: string; id: string } | null>(null)
  const playheads = useRef(new Map<string, number>()).current
  const [history, setHistory] = useState({ undo: false, redo: false })
  const copied = useRef<CanvasSnapshot | null>(null)
  const selectedIds = useRef<string[]>([])
  const [selectedCount, setSelectedCount] = useState(0)
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const connectStart = useRef<{ x: number; y: number } | null>(null)
  const [fileOver, setFileOver] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [frame, setFrame] = useState({ x: 0, y: 0, zoom: 1, width: 0, height: 0 })
  const selectedRef = useRef<string | null>(null)
  const flowRef = useRef<{
    screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number }
    setViewport: (viewport: { x: number; y: number; zoom: number }) => void
    getViewport: () => { x: number; y: number; zoom: number }
    fitView: (options?: { padding?: number; duration?: number }) => unknown
    zoomTo: (zoom: number) => unknown
    flowToScreenPosition: (point: { x: number; y: number }) => { x: number; y: number }
  } | null>(null)
  useEffect(() => {
    if (arrangement && arrangement.key !== layoutKey) {
      flowRef.current?.setViewport(arrangement.viewport)
      setArrangement(null)
    }
  }, [layoutKey, arrangement])
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
  useEffect(() => {
    const el = container.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setFrame((current) => ({ ...current, width: el.clientWidth, height: el.clientHeight }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [container])
  const revealNode = (target: CanvasNode) => {
    if (frame.width && frame.height) {
      const left = target.x * frame.zoom + frame.x
      const top = target.y * frame.zoom + frame.y
      const right = left + target.width * frame.zoom
      const bottom = top + target.height * frame.zoom
      // Reveal only the clipped part; adding a sibling should not recenter the whole canvas.
      const dx = left < 80 ? 80 - left : Math.min(0, frame.width - 48 - right)
      const dy =
        top < 64
          ? 64 - top
          : Math.min(
              0,
              frame.height -
                (target.type === 'text' ? 72 : nodeKind(target) === 'video' ? 480 : 320) -
                bottom,
            )
      if (dx || dy)
        flowRef.current?.setViewport({ zoom: frame.zoom, x: frame.x + dx, y: frame.y + dy })
    }
  }
  const selectNode = (next: string | null) => {
    selectedRef.current = next
    selectedIds.current = next ? [next] : []
    setSelectedCount(next ? 1 : 0)
    setSelectedId(next)
    setSelectedEdges([])
    const target = next ? readCanvasDocument(canvas.doc).nodes.find((n) => n.id === next) : null
    if (target) revealNode(target)
    setNodes((current) => {
      const updated = current.map((n) => ({ ...n, selected: n.id === next }))
      const added =
        next && !current.some((n) => n.id === next)
          ? readCanvasDocument(canvas.doc).nodes.find((n) => n.id === next)
          : null
      if (added) return [...updated, toFlowNode(added, true)]
      const group =
        next && !current.some((n) => n.id === next)
          ? readCanvasDocument(canvas.doc).groups?.find((group) => group.id === next)
          : undefined
      return group ? [...updated, toGroupFlowNode(group, true)] : updated
    })
  }
  const addAsset = async (
    asset: AssetRecord,
    imageId?: string,
    point = placeAt.current,
    targetId?: string,
    targetPrompt?: string,
  ) => {
    if (assetOperation.current) return null
    assetOperation.current = true
    setAddingAsset(true)
    try {
      const id = await insertAssetNode(
        editor,
        canvas,
        asset,
        point,
        targetId,
        imageId,
        targetPrompt,
      )
      if (id && !targetId) selectNode(id)
      return id
    } catch {
      useStore.getState().showToast(t('import.failed'), 'error')
      return null
    } finally {
      assetOperation.current = false
      setAddingAsset(false)
    }
  }
  const selectCreatedBatch = (ids: string[]) => {
    const chosen = new Set(ids)
    const created = readCanvasDocument(canvas.doc).nodes.filter((node) => chosen.has(node.id))
    selectNode(null)
    selectedIds.current = ids
    setSelectedCount(ids.length)
    setNodes((current) => [
      ...current
        .filter((node) => !chosen.has(node.id))
        .map((node) => ({ ...node, selected: false })),
      ...created.map((node) => toFlowNode(node, true)),
    ])
    const bounds = contentBounds({ nodes: created, edges: [], annotations: [] })
    if (bounds && frame.width && frame.height)
      flowRef.current?.setViewport(
        getViewportForBounds(bounds, frame.width, frame.height, 0.1, Math.min(1, frame.zoom), 0.3),
      )
  }
  const center = () => {
    const rect = container.current?.getBoundingClientRect()
    return rect
      ? (flowRef.current?.screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        }) ?? { x: 0, y: 0 })
      : { x: 0, y: 0 }
  }
  const fit = () => {
    void flowRef.current?.fitView({ padding: 0.25, duration: 250 })
  }
  const revertArrangement = () => {
    if (arrangement) flowRef.current?.setViewport(arrangement.viewport)
    setArrangement(null)
  }
  const arrange = () => {
    if (arrangementActive) {
      revertArrangement()
      return
    }
    selectNode(null)
    const positions = arrangeNodes(snapshot)
    setArrangement({ key: layoutKey, positions, viewport: flowRef.current?.getViewport() ?? frame })
    const placement = new Map(positions.map((p) => [p.id, p]))
    const bounds = contentBounds({
      ...snapshot,
      nodes: snapshot.nodes.map((node) => ({ ...node, ...placement.get(node.id) })),
    })
    if (bounds && frame.width && frame.height)
      flowRef.current?.setViewport(
        getViewportForBounds(bounds, frame.width, frame.height, 0.05, 1, 0.25),
      )
  }
  const keepArrangement = () => {
    if (!arrangementActive) return
    canvas.undo.stopCapturing()
    const groups = new Set(snapshot.groups?.map((g) => g.id))
    const members = new Set(snapshot.groups?.flatMap((g) => g.members))
    canvas.doc.transact(() => {
      moveCanvasGroups(
        canvas.doc,
        arrangement.positions.filter((p) => groups.has(p.id)),
        canvas.origin,
      )
      moveCanvasNodes(
        canvas.doc,
        arrangement.positions.filter((p) => !groups.has(p.id) && !members.has(p.id)),
        canvas.origin,
      )
    }, canvas.origin)
    canvas.undo.stopCapturing()
    setArrangement(null)
  }
  const duplicate = () => {
    const content = copyNodes(readCanvasDocument(canvas.doc), selectedIds.current)
    const boxes = content.nodes.length ? content.nodes : (content.groups ?? [])
    if (!boxes.length) return
    const ids = pasteNodes(canvas, content, {
      x: Math.min(...boxes.map((n) => n.x)) + 48,
      y: Math.min(...boxes.map((n) => n.y)) + 48,
    })
    selectNode(ids[0] ?? null)
  }
  const makeGroup = () => {
    const ids = selectedIds.current.filter((id) => snapshot.nodes.some((node) => node.id === id))
    if (!ids.length) return
    const id = newElementId()
    canvas.undo.stopCapturing()
    createCanvasGroup(canvas.doc, id, ids, t('nodes.groupDefault'), canvas.origin)
    selectNode(id)
    closeMenu()
  }
  const ungroup = () => {
    canvas.undo.stopCapturing()
    ungroupCanvasNodes(canvas.doc, selectedIds.current, canvas.origin)
    selectNode(null)
    closeMenu()
  }
  const remove = () => {
    removeNodes(canvas, selectedIds.current, selectedEdges)
    selectNode(null)
    closeMenu()
  }
  const canAddKind = (kind: CreateNodeKind) =>
    (menu?.anchorIds ?? []).every((id) => {
      const anchor = snapshot.nodes.find((node) => node.id === id)
      return (
        !anchor ||
        (menu?.side === 'left'
          ? canvasKindsConnect(kind, nodeKind(anchor))
          : canvasKindsConnect(nodeKind(anchor), kind))
      )
    })
  const addNode = (kind: CreateNodeKind, at = placeAt.current) => {
    if (!canAddKind(kind)) return
    const anchors = menu?.beside ? snapshot.nodes.filter((n) => menu.anchorIds?.includes(n.id)) : []
    const id = createNode(
      canvas,
      kind,
      at,
      textFill,
      anchors.length ? { nodes: anchors, side: menu?.side ?? 'right' } : undefined,
    )
    for (const anchor of menu?.anchorIds ?? [])
      connectCanvasNodes(
        canvas.doc,
        menu?.side === 'left' ? { source: id, target: anchor } : { source: anchor, target: id },
        canvas.origin,
      )
    closeMenu()
    selectNode(id)
  }
  const openMenu = () => {
    placeAt.current = center()
    const rect = container.current?.getBoundingClientRect()
    setMenu({ x: (rect?.left ?? 0) + 80, y: (rect?.top ?? 0) + 140 })
  }
  const textFill = theme === 'dark' ? '#f4f4f5' : '#18181b'
  const placeFiles = (files: File[]) => {
    const images = acceptImageFiles(files)
    if (images.length === 0) return
    const point = placeAt.current
    confirmImageBatch(images.length, () => {
      void (async () => {
        for (const file of images) {
          const id = createNode(canvas, 'image', point, textFill)
          await fillImageNode(editor, canvas.doc, id, file)
          selectNode(id)
        }
      })().catch(() => useStore.getState().showToast(t('import.failed'), 'error'))
    })
  }
  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((one) => [one.id, one]))
      const media = snapshot.nodes.map((node) => {
        const old = previous.get(node.id)
        const selected = old?.selected ?? node.id === selectedRef.current
        return old?.data.node === node && old.selected === selected
          ? old
          : toFlowNode(node, selected)
      })
      return [
        ...(snapshot.groups ?? []).map((group) =>
          toGroupFlowNode(
            group,
            previous.get(group.id)?.selected ?? group.id === selectedRef.current,
          ),
        ),
        ...media,
        ...snapshot.annotations.map((annotation) => {
          const old = previous.get(annotation.id)
          return old?.data.annotation === annotation ? old : toAnnotationNode(annotation)
        }),
      ]
    })
  }, [snapshot])
  useEffect(() => {
    const refresh = () =>
      setHistory({ undo: canvas.undo.undoStack.length > 0, redo: canvas.undo.redoStack.length > 0 })
    canvas.undo.on('stack-item-added', refresh)
    canvas.undo.on('stack-item-popped', refresh)
    canvas.undo.on('stack-cleared', refresh)
    return () => {
      canvas.undo.off('stack-item-added', refresh)
      canvas.undo.off('stack-item-popped', refresh)
      canvas.undo.off('stack-cleared', refresh)
    }
  }, [canvas])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active || event.defaultPrevented) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        target?.isContentEditable ||
        target?.closest(
          'input,textarea,[contenteditable],[role="dialog"],[role="menu"],[role="listbox"],[role="combobox"]',
        )
      )
        return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (arrangementActive) {
        if (event.key === 'Escape') revertArrangement()
        return
      }
      const command = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (command && key === 'z') {
        event.preventDefault()
        event.stopImmediatePropagation()
        canvas.undo.stopCapturing()
        if (event.shiftKey) canvas.undo.redo()
        else canvas.undo.undo()
      } else if (command && key === 'g') {
        event.preventDefault()
        if (event.shiftKey) ungroup()
        else makeGroup()
      } else if (command && key === 'a') {
        event.preventDefault()
        setNodes((current) =>
          current.map((n) => ({ ...n, selected: !!n.data.node || !!n.data.group })),
        )
      } else if (command && key === 'c') {
        event.preventDefault()
        copied.current = copyNodes(readCanvasDocument(canvas.doc), selectedIds.current)
      } else if (command && key === 'v' && copied.current) {
        event.preventDefault()
        const ids = pasteNodes(canvas, copied.current, center())
        selectNode(ids[0] ?? null)
      } else if (command && key === 'd') {
        event.preventDefault()
        duplicate()
      } else if (key === 'delete' || key === 'backspace') {
        event.preventDefault()
        event.stopImmediatePropagation()
        remove()
      } else if (key === 'escape') {
        closeMenu()
        selectNode(null)
      } else if (!command && key === 'v') setMode('select')
      else if (!command && key === 'h') setMode('pan')
      else if (command && ['=', '+', '-'].includes(key)) {
        event.preventDefault()
        void flowRef.current?.zoomTo(frame.zoom * (key === '-' ? 1 / 1.2 : 1.2))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
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
          '.react-flow__node, .react-flow__controls, .react-flow__minimap, .react-flow__handle, .studio-node-menu, .studio-node-composer, .studio-node-tools, .studio-node-navigation, .studio-node-history, textarea, input',
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
      if (event.dataTransfer?.types.some((type) => type === 'Files' || type === ASSET_DRAG_TYPE))
        event.preventDefault()
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
      const assetId = event.dataTransfer.types.includes(ASSET_DRAG_TYPE)
        ? event.dataTransfer.getData(ASSET_DRAG_TYPE)
        : ''
      if (assetId) {
        const asset = useLibraryStore.getState().assets.find((one) => one.id === assetId)
        if (asset) {
          setAssetsOpen(false)
          void addAsset(asset, undefined, point)
        }
        return
      }
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
    selected.data.node.type !== 'text' &&
    selected.data.node.type !== 'timeline'
      ? selected.data.node
      : undefined
  const rawReferences = composerNode
    ? incomingReferences(snapshot.nodes, snapshot.edges, composerNode.id)
    : []
  const meta = composerNode?.data.meta ?? {}
  const parseList = (value: string | undefined): string[] => {
    try {
      const parsed = JSON.parse(value ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  }
  const order = parseList(meta.referenceOrder)
  const references = [...rawReferences].sort((a, b) => {
    const ai = order.indexOf(a.id),
      bi = order.indexOf(b.id)
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
  })
  const roles: Record<string, string> = {}
  for (const ref of references) roles[ref.id] = meta[`role:${ref.id}`] ?? 'reference'
  const draftValue = meta.nodePrompt ?? ''
  const setMeta = (patch: Record<string, string>, trackUndo = true) => {
    if (!composerNode) return
    const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === composerNode.id)
    if (!node || node.type === 'text' || node.type === 'timeline') return
    updateCanvasNode(
      canvas.doc,
      node.id,
      { data: { ...node.data, meta: { ...node.data.meta, ...patch } } },
      trackUndo ? canvas.origin : canvasOrigin('system', 'node-defaults'),
    )
  }
  const available = composerNode
    ? incomingReferences(
        snapshot.nodes,
        snapshot.nodes
          .filter(
            (n) =>
              canvasConnectionAllowed(n, composerNode) && !references.some((r) => r.id === n.id),
          )
          .map((n) => ({ id: n.id, source: n.id, target: composerNode.id })),
        composerNode.id,
      )
    : []
  const referenceTools = composerNode ? (
    <NodeReferenceEditor
      references={references}
      files={files}
      available={available}
      onAdd={(id) =>
        connectCanvasNodes(canvas.doc, { source: id, target: composerNode.id }, canvas.origin)
      }
      onRemove={(id) => {
        const edge = snapshot.edges.find((e) => e.source === id && e.target === composerNode.id)
        if (edge) disconnectCanvasNodes(canvas.doc, edge.id, canvas.origin)
      }}
      onMove={(id) => {
        const ids = references.map((r) => r.id)
        const at = ids.indexOf(id)
        if (at > 0) [ids[at - 1], ids[at]] = [ids[at]!, ids[at - 1]!]
        setMeta({ referenceOrder: JSON.stringify(ids) })
      }}
      roles={undefined}
      onRole={(id, role) => {
        const patch: Record<string, string> = { [`role:${id}`]: role }
        if (role === 'first' || role === 'last')
          for (const ref of references)
            if (ref.id !== id && roles[ref.id] === role) patch[`role:${ref.id}`] = 'reference'
        setMeta(patch)
      }}
    />
  ) : null
  const busy = composerNode?.data.pending
    ? composerNode.data.pending.type === 'generation'
      ? !composerNode.data.pending.errorCode
      : composerNode.data.pending.status === 'loading'
    : false
  const composerAt = composerNode && selected ? composerAnchor(selected, frame) : null
  const uploadInto = (id: string, file: File) => {
    void fillImageNode(editor, canvas.doc, id, file).catch(() =>
      useStore.getState().showToast(t('import.failed'), 'error'),
    )
  }
  const spawnBeside = (nodeId: string, side: 'left' | 'right') => {
    const node = snapshot.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const ids = selectedIds.current.includes(nodeId) ? selectedIds.current : [nodeId]
    placeAt.current = {
      x: node.x + (side === 'right' ? node.width + 32 : -32),
      y: node.y + node.height / 2,
    }
    const screen = flowRef.current?.flowToScreenPosition?.(placeAt.current) ?? { x: 200, y: 200 }
    setMenu({ ...screen, anchorIds: ids, side, beside: true })
  }
  const editNode = (
    id: string,
    patch: { name?: string; width?: number; height?: number; x?: number; y?: number },
  ) => {
    const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === id)
    if (!node) return
    canvas.undo.stopCapturing()
    const { name, ...size } = patch
    updateCanvasNode(
      canvas.doc,
      id,
      { ...size, ...(name !== undefined ? { data: { ...node.data, name } } : {}) },
      canvas.origin,
    )
  }
  const [litEdgeIds, setLitEdgeIds] = useState<ReadonlySet<string> | null>(null)
  const highlightedEdges =
    litEdgeIds ??
    new Set(
      snapshot.edges
        .filter((edge) => edge.source === selectedId || edge.target === selectedId)
        .map((edge) => edge.id),
    )
  const litRef = useRef(litEdgeIds)
  litRef.current = litEdgeIds
  const connectDrop = (
    event: MouseEvent | TouchEvent,
    state: {
      fromNode: { id: string } | null
      fromHandle: { type: 'source' | 'target' } | null
    },
  ) => {
    const from = state.fromNode
    if (!from) return
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    if (!point) return
    const link = linkFromDrag(
      { nodeId: from.id, handleType: state.fromHandle?.type ?? null },
      nodeIdAtPoint(point.clientX, point.clientY),
    )
    if (link) connectCanvasNodes(canvas.doc, link, canvas.origin)
    else if (
      !nodeIdAtPoint(point.clientX, point.clientY) &&
      connectStart.current &&
      Math.hypot(point.clientX - connectStart.current.x, point.clientY - connectStart.current.y) > 8
    ) {
      placeAt.current =
        flowRef.current?.screenToFlowPosition({ x: point.clientX, y: point.clientY }) ?? center()
      setMenu({
        x: point.clientX,
        y: point.clientY,
        anchorIds: selectedIds.current.includes(from.id) ? selectedIds.current : [from.id],
        side: state.fromHandle?.type === 'target' ? 'left' : 'right',
      })
    }
  }
  return (
    <NodeVideoPlayheadContext.Provider value={playheads}>
      <PreviewContext.Provider value={showPreview}>
        <RenameGroupContext.Provider
          value={(id, name) => {
            canvas.undo.stopCapturing()
            renameCanvasGroup(canvas.doc, id, name, canvas.origin)
          }}
        >
          <EditNodeContext.Provider value={editNode}>
            <TextCanvasContext.Provider value={canvas}>
              <FillImageContext.Provider value={uploadInto}>
                <SpawnContext.Provider value={spawnBeside}>
                  <ReactFlow<FlowNode>
                    nodes={
                      arrangementActive
                        ? nodes.map((n) => ({
                            ...n,
                            position: arrangementPositions.get(n.id) ?? n.position,
                          }))
                        : nodes
                    }
                    className={arrangementActive ? 'studio-node-arranging' : undefined}
                    nodesDraggable={!arrangementActive}
                    nodesConnectable={!arrangementActive}
                    elementsSelectable={!arrangementActive}
                    edges={snapshot.edges.map((edge) => ({
                      id: edge.id,
                      type: 'reference',
                      source: edge.source,
                      target: edge.target,
                      interactionWidth: 22,
                      hidden: !connections,
                      selected: selectedEdges.includes(edge.id),
                      className: highlightedEdges.has(edge.id) ? 'studio-edge-lit' : undefined,
                      zIndex: highlightedEdges.has(edge.id) ? 1 : 0,
                    }))}
                    onEdgeMouseEnter={(_event, edge) => {
                      setLitEdgeIds(new Set(flowEdgeIds(snapshot.edges, edge.id)))
                    }}
                    onEdgeMouseLeave={(event) => {
                      const next = event.relatedTarget
                      const nextId =
                        next instanceof Element
                          ? next.closest('.react-flow__edge')?.getAttribute('data-id')
                          : null
                      if (nextId && litRef.current?.has(nextId)) return
                      setLitEdgeIds(null)
                    }}
                    edgeTypes={edgeTypes}
                    nodeTypes={nodeTypes}
                    zoomOnDoubleClick={false}
                    selectionOnDrag={mode === 'select'}
                    selectionMode={SelectionMode.Partial}
                    panOnDrag={mode === 'pan' ? true : [1, 2]}
                    panOnScroll
                    zoomOnScroll={false}
                    multiSelectionKeyCode="Shift"
                    onSelectionChange={({ nodes: selected }) => {
                      if (arrangementActive) return
                      const ids = selected
                        .filter((n) => n.data.node || n.data.group)
                        .map((n) => n.id)
                      selectedIds.current = ids
                      if (ids.length) setSelectedEdges((current) => (current.length ? [] : current))
                      setSelectedCount(ids.length)
                      const id = ids.length === 1 ? ids[0]! : null
                      selectedRef.current = id
                      setSelectedId(id)
                    }}
                    onPaneContextMenu={(event) => {
                      event.preventDefault()
                      placeAt.current =
                        flowRef.current?.screenToFlowPosition({
                          x: event.clientX,
                          y: event.clientY,
                        }) ?? center()
                      setMenu({ x: event.clientX, y: event.clientY })
                    }}
                    onNodeClick={(event, node) => {
                      if (arrangementActive) return
                      if (!event.shiftKey && node.data.node) revealNode(node.data.node)
                    }}
                    onNodeContextMenu={(event, node) => {
                      event.preventDefault()
                      if (arrangementActive) return
                      if (!selectedIds.current.includes(node.id)) selectNode(node.id)
                      placeAt.current = center()
                      setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id })
                    }}
                    onEdgeClick={(event, edge) => {
                      event.stopPropagation()
                      selectNode(null)
                      setSelectedEdges([edge.id])
                    }}
                    onConnectStart={(event) => {
                      const point = 'touches' in event ? event.touches[0] : event
                      if (point) connectStart.current = { x: point.clientX, y: point.clientY }
                    }}
                    elevateNodesOnSelect={false}
                    onNodesChange={(changes: NodeChange<FlowNode>[]) =>
                      setNodes((current) => {
                        const next = applyNodeChanges(changes, current)
                        const changed = new Set(
                          changes
                            .filter((change) => change.type === 'position')
                            .map((change) => change.id),
                        )
                        const shifts = new Map<string, { x: number; y: number }>()
                        for (const group of next.filter(
                          (node) => node.data.group && changed.has(node.id),
                        )) {
                          const previous = current.find((node) => node.id === group.id)
                          if (!previous) continue
                          for (const id of group.data.group!.members)
                            shifts.set(id, {
                              x: group.position.x - previous.position.x,
                              y: group.position.y - previous.position.y,
                            })
                        }
                        return next.map((node) => {
                          const shift = shifts.get(node.id)
                          return shift && !changed.has(node.id)
                            ? {
                                ...node,
                                position: {
                                  x: node.position.x + shift.x,
                                  y: node.position.y + shift.y,
                                },
                              }
                            : node
                        })
                      })
                    }
                    onPaneClick={() => {
                      selectNode(null)
                      closeMenu()
                    }}
                    onConnect={(connection) => {
                      if (!connection.source || !connection.target) return
                      connectCanvasNodes(
                        canvas.doc,
                        { source: connection.source, target: connection.target },
                        canvas.origin,
                      )
                    }}
                    onConnectEnd={connectDrop}
                    isValidConnection={(connection) =>
                      Boolean(
                        connection.source &&
                          connection.target &&
                          canvasLinkAllowed(snapshot, {
                            source: connection.source,
                            target: connection.target,
                          }),
                      )
                    }
                    onNodeDragStart={() => canvas.undo.stopCapturing()}
                    onNodeDragStop={(_event, _node, dragged) => {
                      const groups = dragged.filter((one) => one.data.group)
                      const members = new Set(groups.flatMap((one) => one.data.group!.members))
                      const free = dragged.filter((one) => one.data.node && !members.has(one.id))
                      canvas.doc.transact(() => {
                        moveCanvasGroups(
                          canvas.doc,
                          groups.map((one) => ({ id: one.id, ...one.position })),
                          canvas.origin,
                        )
                        moveCanvasNodes(
                          canvas.doc,
                          free.map((one) => ({ id: one.id, ...one.position })),
                          canvas.origin,
                        )
                        reconcileCanvasGroupMembership(
                          canvas.doc,
                          free.map((one) => one.id),
                          canvas.origin,
                        )
                      }, canvas.origin)
                      canvas.undo.stopCapturing()
                    }}
                    onMove={(_event, viewport) => remember(viewport)}
                    onMoveEnd={(_event, viewport) =>
                      safeLocalStorage.setItem(
                        scopedStorageName(`node-viewport:${viewKey}`),
                        JSON.stringify(viewport),
                      )
                    }
                    colorMode={theme}
                    minZoom={0.05}
                    maxZoom={8}
                    onInit={(flow) => {
                      flowRef.current = flow
                      const bounds = contentBounds(snapshot)
                      const box = container.current
                      // 容器还没量出尺寸时留默认视口，免得按 0 宽高缩到最小。
                      let saved: { x: number; y: number; zoom: number } | undefined
                      try {
                        const value = JSON.parse(
                          safeLocalStorage.getItem(scopedStorageName(`node-viewport:${viewKey}`)) ??
                            'null',
                        )
                        if (
                          value &&
                          [value.x, value.y, value.zoom].every(Number.isFinite) &&
                          value.zoom >= 0.05 &&
                          value.zoom <= 8
                        )
                          saved = value
                      } catch {}
                      if (saved) flow.setViewport(saved)
                      else if (bounds && box?.clientWidth && box.clientHeight) {
                        // 与旧画布一致：打开时最多按 100% 显示。
                        flow.setViewport(
                          getViewportForBounds(
                            bounds,
                            box.clientWidth,
                            box.clientHeight,
                            0.05,
                            1,
                            0.1,
                          ),
                        )
                      }
                      remember(flow.getViewport())
                    }}
                    deleteKeyCode={null}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
                    {minimap && <MiniMap pannable zoomable position="bottom-right" />}
                  </ReactFlow>
                  <NodeCanvasToolbar
                    onCreate={(kind) => addNode(kind, center())}
                    onMenu={openMenu}
                    onAssets={() => {
                      placeAt.current = center()
                      setAssetsOpen(true)
                    }}
                    onUpload={() => {
                      placeAt.current = center()
                      fileInput.current?.click()
                    }}
                    mode={mode}
                    onMode={setMode}
                    zoom={frame.zoom}
                    onZoom={(zoom) =>
                      void flowRef.current?.zoomTo(Math.max(0.05, Math.min(8, zoom)))
                    }
                    onFit={fit}
                    minimap={minimap}
                    onMinimap={() => setMinimap(!minimap)}
                    connections={connections}
                    onConnections={() => setConnections(!connections)}
                    onArrange={arrange}
                    canArrange={snapshot.nodes.length > 1}
                    arranging={arrangementActive}
                    onKeepArrangement={keepArrangement}
                    onRevertArrangement={revertArrangement}
                    onUndo={() => canvas.undo.undo()}
                    onRedo={() => canvas.undo.redo()}
                    canUndo={history.undo}
                    canRedo={history.redo}
                    onChat={onChat}
                  />
                  {snapshot.nodes.length === 0 && (
                    <div className="studio-node-empty-hint text-body-md">
                      {t('nodes.emptyHint')}
                    </div>
                  )}
                  {selected?.data.group && (
                    <div className="studio-node-selection-bar text-label-md">
                      <span>{selected.data.group.name}</span>
                      <NodeTool icon="folder" label={t('nodes.ungroup')} onClick={ungroup} />
                      <NodeTool icon="duplicate" label={t('nodes.duplicate')} onClick={duplicate} />
                    </div>
                  )}
                  {selectedCount > 1 && (
                    <div className="studio-node-selection-bar text-label-md">
                      <span>{t('nodes.selectedCount', { count: selectedCount })}</span>
                      <NodeTool icon="folder" label={t('nodes.group')} onClick={makeGroup} />
                      <NodeTool
                        icon="add"
                        label={t('nodes.newFromSelection')}
                        onClick={() =>
                          spawnBeside(selectedIds.current[selectedIds.current.length - 1]!, 'right')
                        }
                      />
                      <NodeTool icon="duplicate" label={t('nodes.duplicate')} onClick={duplicate} />
                      <NodeTool icon="delete" label={t('nodes.delete')} onClick={remove} />
                    </div>
                  )}
                  {assetsOpen && (
                    <NodeAssetPicker
                      onClose={() => setAssetsOpen(false)}
                      onChoose={(asset, imageId) => {
                        setAssetsOpen(false)
                        void addAsset(asset, imageId)
                      }}
                    />
                  )}
                  {imageEditId && (
                    <Suspense fallback={null}>
                      <NodeImageEditor
                        editor={editor}
                        canvas={canvas}
                        nodeId={imageEditId}
                        onClose={() => setImageEditId(null)}
                      />
                    </Suspense>
                  )}
                  {preview && <ImagePreview src={preview} onClose={() => setPreview(null)} />}
                  {videoPreview && (
                    <Overlay onClose={() => setVideoPreview(null)} label={t('nodes.preview')}>
                      <div className="relative h-[80vh] w-[90vw]">
                        <CanvasVideoPlayer
                          src={videoPreview.src}
                          onTimeChange={(seconds) => playheads.set(videoPreview.id, seconds)}
                          onEnded={() => {}}
                        />
                        <Button
                          className="absolute right-2 top-2"
                          onClick={() => setVideoPreview(null)}
                        >
                          {common('action.close')}
                        </Button>
                      </div>
                    </Overlay>
                  )}
                  {composerNode &&
                    selected &&
                    (composerNode.type === 'video' ||
                      ('fileId' in composerNode.data && composerNode.data.fileId)) && (
                      <div
                        className="studio-node-media-actions"
                        style={{
                          left: Math.max(
                            150,
                            Math.min(
                              selected.position.x * frame.zoom +
                                frame.x +
                                ((selected.width ?? 0) * frame.zoom) / 2,
                              frame.width - 150,
                            ),
                          ),
                          top: Math.max(72, selected.position.y * frame.zoom + frame.y - 78),
                        }}
                      >
                        <NodeTool
                          icon="fullscreen"
                          label={t('nodes.preview')}
                          onClick={() => {
                            if (composerNode.type === 'video') {
                              setVideoPreview({
                                id: composerNode.id,
                                src: videoOutputUrl(composerNode.data.video),
                              })
                            } else {
                              const source = files[composerNode.data.fileId!]
                              if (source) showPreview(source)
                            }
                          }}
                        />
                        {composerNode.type === 'image' && (
                          <NodeTool
                            icon="layers"
                            label={t('nodes.saveAsAsset')}
                            onClick={() => {
                              void saveNodeAsAsset(editor, canvas, composerNode.id).catch(() =>
                                useStore.getState().showToast(t('import.failed'), 'error'),
                              )
                            }}
                          />
                        )}
                        <NodeTool
                          icon="download"
                          label={
                            composerNode.type === 'video'
                              ? common('action.download')
                              : t('nodes.download')
                          }
                          onClick={() => {
                            const source =
                              composerNode.type === 'video'
                                ? videoOutputUrl(composerNode.data.video)
                                : files[composerNode.data.fileId!]
                            if (source) {
                              void resolveMediaSource(source, 'original', true)
                                .then((url) => fetch(url, { credentials: 'include' }))
                                .then(async (response) => {
                                  if (!response.ok) throw new Error('download failed')
                                  const blob = await response.blob()
                                  const extension =
                                    blob.type.split('/')[1]?.split(';')[0] ||
                                    (composerNode.type === 'video' ? 'mp4' : 'png')
                                  const name = composerNode.data.name || 'muvloom'
                                  downloadBlob(
                                    blob,
                                    /\.(png|jpe?g|webp|avif|gif|mp4|webm)$/i.test(name)
                                      ? name
                                      : `${name}.${extension}`,
                                  )
                                })
                                .catch(() =>
                                  useStore.getState().showToast(t('import.failed'), 'error'),
                                )
                            }
                          }}
                        />
                        {composerNode.type === 'image' && nodeKind(composerNode) === 'image' && (
                          <NodeTool
                            icon="brush"
                            label={t('pixelEdit.title')}
                            onClick={() => setImageEditId(composerNode.id)}
                          />
                        )}
                        {composerNode.type === 'video' && (
                          <NodeVideoTools
                            key={`${composerNode.id}:${composerNode.data.video.taskId}:${composerNode.data.video.outputIndex}`}
                            editor={editor}
                            canvas={canvas}
                            node={composerNode}
                            onCreated={selectCreatedBatch}
                          />
                        )}
                        {composerNode.type === 'image' && nodeKind(composerNode) === 'image' && (
                          <NodeSliceMenu
                            key={composerNode.id}
                            editor={editor}
                            canvas={canvas}
                            nodeId={composerNode.id}
                            onCreated={selectCreatedBatch}
                          />
                        )}
                        <NodeTool
                          icon="duplicate"
                          label={t('nodes.duplicate')}
                          onClick={duplicate}
                        />
                        <NodeTool icon="delete" label={t('nodes.delete')} onClick={remove} />
                      </div>
                    )}
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
                      disabledKinds={(['text', 'image', 'video'] as const).filter(
                        (kind) => !canAddKind(kind),
                      )}
                      x={menu.x}
                      y={menu.y}
                      onClose={closeMenu}
                      onText={() => addNode('text')}
                      onImage={() => addNode('image')}
                      onVideo={() => addNode('video')}
                      onAssets={() => {
                        closeMenu()
                        setAssetsOpen(true)
                      }}
                      actions={
                        menu.nodeId
                          ? [
                              ...(canvasResults(canvas.doc, menu.nodeId).length > 1
                                ? [
                                    {
                                      icon: 'grid' as const,
                                      label: t('nodes.spreadCandidates'),
                                      onClick: () => {
                                        const id = menu.nodeId!
                                        closeMenu()
                                        void spreadNodeResults(editor, canvas, id)
                                          .then(selectCreatedBatch)
                                          .catch(() =>
                                            useStore
                                              .getState()
                                              .showToast(t('nodes.candidateUnavailable'), 'error'),
                                          )
                                      },
                                    },
                                  ]
                                : []),
                              {
                                icon: 'folder',
                                label: t(selected?.data.group ? 'nodes.ungroup' : 'nodes.group'),
                                onClick: selected?.data.group ? ungroup : makeGroup,
                              },
                              {
                                icon: 'copy',
                                label: t('nodes.copy'),
                                onClick: () => {
                                  copied.current = copyNodes(snapshot, selectedIds.current)
                                  closeMenu()
                                },
                              },
                              {
                                icon: 'duplicate',
                                label: t('nodes.duplicate'),
                                onClick: () => {
                                  duplicate()
                                  closeMenu()
                                },
                              },
                              { icon: 'delete', label: t('nodes.delete'), onClick: remove },
                            ]
                          : copied.current
                            ? [
                                {
                                  icon: 'copy',
                                  label: t('nodes.paste'),
                                  onClick: () => {
                                    const ids = pasteNodes(canvas, copied.current!, placeAt.current)
                                    selectNode(ids[0] ?? null)
                                    closeMenu()
                                  },
                                },
                              ]
                            : undefined
                      }
                      onUpload={() => {
                        closeMenu()
                        fileInput.current?.click()
                      }}
                    />
                  )}
                  {composerNode && nodeKind(composerNode) === 'image' && composerAt && (
                    <ImageNodeComposer
                      resultTools={
                        <>
                          <NodeResultPicker
                            key={composerNode.id}
                            canvas={canvas}
                            editor={editor}
                            nodeId={composerNode.id}
                          />
                          <NodeAssetTools
                            key={`asset:${composerNode.id}`}
                            canvas={canvas}
                            editor={editor}
                            nodeId={composerNode.id}
                            busy={busy || addingAsset}
                          />
                        </>
                      }
                      onAsset={async (asset, prompt) =>
                        !!(await addAsset(
                          asset,
                          undefined,
                          placeAt.current,
                          composerNode.id,
                          prompt,
                        ))
                      }
                      key={composerNode.id}
                      document={canvas.doc}
                      nodeId={composerNode.id}
                      referenceTools={referenceTools}
                      references={references}
                      files={files}
                      value={draftValue}
                      busy={busy || addingAsset}
                      position={composerAt}
                      onChange={(value) => {
                        setMeta({ nodePrompt: value })
                      }}
                      onSubmit={(temporaryReferences) => {
                        const value = draftValue
                        const urls = referenceFileIds(references, files).flatMap((id) => {
                          const source = files[id]
                          return source ? [source] : []
                        })
                        urls.push(...temporaryReferences)
                        submitNodeImage(
                          editor,
                          canvas.doc,
                          composerNode.id,
                          [assetNodeContext(composerNode), composeNodePrompt(value, references)]
                            .filter(Boolean)
                            .join('\n\n'),
                          urls,
                        )
                      }}
                    />
                  )}
                  {composerNode && nodeKind(composerNode) === 'video' && composerAt && (
                    <VideoNodeComposer
                      resultTools={
                        <NodeResultPicker
                          key={composerNode.id}
                          canvas={canvas}
                          editor={editor}
                          nodeId={composerNode.id}
                        />
                      }
                      onAsset={async (asset, prompt) =>
                        !!(await addAsset(
                          asset,
                          undefined,
                          placeAt.current,
                          composerNode.id,
                          prompt,
                        ))
                      }
                      key={composerNode.id}
                      document={canvas.doc}
                      nodeId={composerNode.id}
                      meta={meta}
                      onMeta={setMeta}
                      references={references}
                      files={files}
                      value={draftValue}
                      onChange={(value) => setMeta({ nodePrompt: value })}
                      onSubmit={(draft, activeRefs, activeRoles, activeFiles) =>
                        submitNodeVideo(
                          editor,
                          canvas.doc,
                          composerNode.id,
                          composeNodePrompt(draftValue, activeRefs),
                          activeRefs,
                          activeRoles,
                          activeFiles,
                          draft,
                        )
                      }
                      busy={busy || addingAsset}
                      position={composerAt}
                      referenceTools={referenceTools}
                    />
                  )}
                </SpawnContext.Provider>
              </FillImageContext.Provider>
            </TextCanvasContext.Provider>
          </EditNodeContext.Provider>
        </RenameGroupContext.Provider>
      </PreviewContext.Provider>
    </NodeVideoPlayheadContext.Provider>
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
  const top = node.position.y * zoom + frame.y + height * zoom + 16
  if (frame.width <= 0) return { left: center, top }
  const panel = Math.min(560, Math.max(280, frame.width - 24))
  const limit = Math.max(panel / 2 + 12, frame.width - panel / 2 - 12)
  return {
    left: Math.min(Math.max(center, panel / 2 + 12), limit),
    top,
  }
}

/** 节点画布（`canvas:nodes`）：一个项目的 `Y.Doc` 渲染成 React Flow。 */
export default function NodeCanvas({
  workspace,
  active,
  onChat,
}: {
  onChat?: () => void
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
    if (workspace.cloud && 'canvas' in workspace.cloud && workspace.cloud.canvas) {
      // Another device may still be submitting a task; only resume confirmed server jobs.
      const document = workspace.cloud.canvas.doc
      let alive = true
      let queued = false
      const recover = () => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          if (!alive) return
          resumeNodeGenerations(workspace.editor, document, false)
          resumeNodeVideos(workspace.editor, document, false)
        })
      }
      document.on('update', recover)
      recover()
      setCanvas(workspace.cloud.canvas)
      setFailed(false)
      return () => {
        alive = false
        document.off('update', recover)
      }
    }
    let alive = true
    let opened: NodeCanvasDocument | undefined
    let projecting = false
    const projectVideoEdits = () => {
      if (!opened || !alive) return
      projecting = true
      try {
        projectNodeVideoEdits(workspace.editor, opened)
      } finally {
        projecting = false
      }
    }
    let previous = workspace.doc.elements as readonly LegacyCanvasElement[]
    const queued: Array<readonly [readonly LegacyCanvasElement[], readonly LegacyCanvasElement[]]> =
      []
    const unsubscribe = workspace.doc.subscribe(() => {
      const next = workspace.doc.elements as readonly LegacyCanvasElement[]
      if (opened && alive && !projecting)
        synchronizeLegacyElements(opened.doc, previous, next, legacyOrigin)
      else if (!opened && alive && previous !== next) queued.push([previous, next])
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
        one.doc.on('update', projectVideoEdits)
        projectVideoEdits()
        resumeNodeGenerations(workspace.editor, one.doc)
        resumeNodeVideos(workspace.editor, one.doc)
        setCanvas(one)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
      unsubscribe()
      opened?.doc.off('update', projectVideoEdits)
      void opened?.destroy()
    }
  }, [key, workspace])
  // 位图表一变整个组件就重渲染；挡住它，免得每加一张图都把整块 React Flow 重画一遍。
  const content = useMemo(
    () =>
      canvas && (
        <ReactFlowProvider>
          <Flow
            canvas={canvas}
            container={container}
            editor={workspace.editor}
            active={active}
            onChat={onChat}
            viewKey={workspace.record.key}
          />
        </ReactFlowProvider>
      ),
    [canvas, active, workspace.editor, onChat],
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
