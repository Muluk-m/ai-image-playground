import {
  beginCanvasTimelineEdit,
  type CanvasAnnotation,
  type CanvasGroup,
  type CanvasNode,
  type CanvasSnapshot,
  canvasKindsConnect,
  canvasLinkAllowed,
  canvasOrigin,
  canvasResults,
  canvasText,
  connectCanvasNodes,
  createCanvasGroup,
  disconnectCanvasNodes,
  type ImageNodeData,
  moveCanvasGroups,
  moveCanvasNodes,
  type PendingGeneration,
  readCanvasDocument,
  reconcileCanvasGroupMembership,
  renameCanvasGroup,
  renderScriptDocument,
  type ScriptBrief,
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
  type CSSProperties,
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
import type * as Y from 'yjs'
import { ImagePreview } from '../../../components/Lightbox'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import { safeLocalStorage, scopedStorageName } from '../../../lib/authScope'
import { videoOutputUrl } from '../../../lib/channels/queueClient'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { downloadBlob } from '../../../lib/downloadImages'
import { reportDeliveryFailure } from '../../../lib/errorReporting'
import { acceptImageFiles, collectDroppedFiles } from '../../../lib/imageFiles'
import { MAX_INPUT_IMAGES_MESSAGE } from '../../../lib/inputImageLimit'
import { useStore } from '../../../store'
import { useTheme } from '../../../theme/useTheme'
import { useActiveLook } from '../../library/lib/activeLook'
import { useLibraryStore } from '../../library/store'
import type { AssetRecord } from '../../library/types'
import PlayBadge from '../../video/components/PlayBadge'
import { arrangementKey, arrangeNodes, type CanvasPlacement } from '../lib/arrangeNodes'
import { newElementId } from '../lib/canvasDoc'
import {
  type CanvasViewportBox,
  planCanvasViewport,
  withLivePositions,
} from '../lib/canvasViewport'
import type { CanvasEditor } from '../lib/editor'
import { ARROW_POINTER, freedrawOutline } from '../lib/konvaShapes'
import { openLocalNodeCanvas } from '../lib/localNodeCanvas'
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
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import {
  composeNodePrompt,
  flowEdgeIds,
  incomingReferences,
  linkFromDrag,
  referenceFileIds,
} from '../lib/nodeCanvasFlow'
import { type NodeCanvasFocus, registerNodeCanvasFocus } from '../lib/nodeCanvasFocus'
import { fillImageNode, resumeNodeGenerations, submitNodeImage } from '../lib/nodeCanvasGenerate'
import { nodeCardSize } from '../lib/nodeCanvasPlace'
import {
  addCanvasReference,
  CanvasReferenceLimitError,
  canvasReferenceCandidates,
  type ReferenceSlot,
  uploadCanvasReference,
} from '../lib/nodeCanvasReferences'
import { spreadNodeResults } from '../lib/nodeCanvasResults'
import { clearNodeCanvasSelection, setNodeCanvasSelection } from '../lib/nodeCanvasSelection'
import { resumeNodeVideos, submitNodeVideo } from '../lib/nodeCanvasVideo'
import { submitNodeWithLook } from '../lib/nodeLookSubmit'
import { useStoryboardGridSplitting } from '../lib/nodeStoryboardGrid'
import { generateTextNode } from '../lib/textGeneration'
import { useAgentNodeRun } from '../lib/useAgentNodeRun'
import type { CanvasWorkspace } from '../lib/workspaces'
import { useCanvasProjectStore } from '../projectStore'
import { CanvasLodProvider, CanvasOverview, NodeLodCard, useCanvasLod } from './CanvasLod'
import CanvasVideoPlayer from './CanvasVideoPlayer'
import FilmExportStatus from './FilmExportStatus'
import ImageNodeComposer from './ImageNodeComposer'
import NodeAddMenu from './NodeAddMenu'
import NodeAssetPicker from './NodeAssetPicker'
import NodeAssetTools from './NodeAssetTools'
import NodeBatchDialog from './NodeBatchDialog'
import NodeCanvasToolbar, { NodeTool } from './NodeCanvasToolbar'
import NodeFlowEdge from './NodeFlowEdge'
import NodeGroup, { RenameGroupContext } from './NodeGroup'
import NodePorts, { SpawnContext } from './NodePorts'
import NodeReferenceEditor from './NodeReferenceEditor'
import NodeResultPicker from './NodeResultPicker'
import NodeSliceMenu from './NodeSliceMenu'
import NodeStoryboard, { NodeStoryboardContext } from './NodeStoryboard'
import NodeTextBody, { TextCanvasContext } from './NodeTextBody'
import NodeTimeline, { NodeTimelineContext } from './NodeTimeline'
import NodeVideoTools, { NodeVideoPlayheadContext } from './NodeVideoTools'
import ScriptBriefDialog from './ScriptBriefDialog'
import TextNodeComposer from './TextNodeComposer'
import TimelineEditorHost from './TimelineEditor'
import VideoNodeComposer from './VideoNodeComposer'

const NodeImageEditor = lazy(() => import('./NodeImageEditor'))

type FlowNode = Node<{ node?: CanvasNode; annotation?: CanvasAnnotation; group?: CanvasGroup }>
const edgeTypes = { reference: NodeFlowEdge }
const NODE_CAPTION_CLEARANCE = 30

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

function nodeIconName(node: CanvasNode): IconName {
  if ('meta' in node.data && node.data.meta?.nodeKind === 'asset') {
    const kind = node.type === 'image' ? node.data.meta.assetKind : undefined
    if (kind === 'person') return 'character'
    if (kind === 'location') return 'location'
    if (kind === 'product') return 'product'
    if (kind === 'prop') return 'toolbox'
    return 'layers'
  }
  const kind = nodeKind(node)
  return kind === 'text' ? 'text' : kind === 'video' ? 'video' : 'image'
}

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
      <Icon name={nodeIconName(node)} size="xs" />
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
  const { width, height } = nodeCardSize(node)
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
  const pendingAsset = node.data.meta?.nodeKind === 'asset' && !fileId && !node.data.mediaId
  return (
    <>
      <NodePorts nodeId={node.id} />
      <NodeCaption node={node} />
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
        data-asset-pending={pendingAsset || undefined}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (fileId && files[fileId]) preview(files[fileId])
        }}
      >
        {pendingAsset && (
          <span className="absolute right-3 top-3 rounded-full bg-warning/15 px-2 py-1 text-xs font-medium text-warning">
            {t('nodes.assetPending')}
          </span>
        )}
        {fileId ? (
          <Picture fileId={fileId} rotation={rotation} />
        ) : pending ? (
          <Pending pending={pending} />
        ) : (
          <div className="studio-node-empty">
            <Icon name={nodeIconName(node)} size="lg" />
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

const VideoNode = memo(function VideoNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const files = useContext(FilesContext)
  const [playing, setPlaying] = useState(false)
  const playheads = useContext(NodeVideoPlayheadContext)
  const poster = useNodeMedia(
    !node || !('fileId' in node.data) || !node.data.fileId ? undefined : files[node.data.fileId],
  )
  if (!node || (node.type !== 'video' && node.type !== 'image')) return null
  const { fileId, rotation, pending } = node.data
  const video = node.type === 'video' ? node.data.video : undefined
  if (!video)
    return (
      <>
        <NodePorts nodeId={node.id} />
        <NodeCaption node={node} />
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
        <NodeCaption node={node} />
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
  const { t } = useTranslation('canvas')
  const lod = useCanvasLod()
  if (lod === 'card')
    return (
      <NodeLodCard
        label={node?.type === 'text' ? node.data.name || t('nodes.addText') : undefined}
      />
    )
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

const StoryboardNode = memo(function StoryboardNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const lod = useCanvasLod()
  if (lod === 'card') return <NodeLodCard label={t('storyboard.title')} />
  return node?.type === 'storyboard' ? <NodeStoryboard node={node} /> : null
})

const TimelineNode = memo(function TimelineNode({ data: { node } }: NodeProps<FlowNode>) {
  const { t } = useTranslation('canvas')
  const lod = useCanvasLod()
  if (lod === 'card') return <NodeLodCard label={t('timeline.title')} />
  return node?.type === 'timeline' ? <NodeTimeline node={node} /> : null
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
  const lod = useCanvasLod()
  if (lod === 'card') return <NodeLodCard />
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
  storyboard: StoryboardNode,
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
  for (const node of nodes) {
    const { width, height } = nodeCardSize(node)
    include(node.x, node.y, node.x + width, node.y + height)
  }
  for (const one of annotations) {
    const bounds = annotationBounds(one)
    include(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Use the same display geometry for navigation and culling without rewriting document data. */
function boundsOf(
  snapshot: CanvasSnapshot,
  ids?: ReadonlySet<string>,
  liveNodes?: readonly FlowNode[],
): Rect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const include = (x: number, y: number, width: number, height: number) => {
    if (![x, y, width, height].every(Number.isFinite)) return
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + width)
    maxY = Math.max(maxY, y + height)
  }
  const liveById = new Map(
    liveNodes
      ?.filter((node) => node.data.node)
      .map(
        (node) =>
          [node.id, { ...node.data.node!, x: node.position.x, y: node.position.y }] as const,
      ),
  )
  const seenNodeIds = new Set<string>()
  for (const group of snapshot.groups ?? []) {
    if (!ids || ids.has(group.id)) include(group.x, group.y, group.width, group.height)
  }
  for (const node of snapshot.nodes) {
    if (ids && !ids.has(node.id)) continue
    const current = liveById.get(node.id) ?? node
    const { width, height } = nodeCardSize(current)
    include(current.x, current.y, width, height)
    seenNodeIds.add(node.id)
  }
  for (const [id, node] of liveById) {
    if (!seenNodeIds.has(id) && (!ids || ids.has(id))) {
      const { width, height } = nodeCardSize(node)
      include(node.x, node.y, width, height)
    }
  }
  for (const annotation of snapshot.annotations) {
    if (ids && !ids.has(annotation.id)) continue
    const box = annotationBounds(annotation)
    include(box.x, box.y, box.width, box.height)
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Overlay footprints are measured in screen pixels; changing composer height must not hide nodes. */
function availableCanvasArea(container: HTMLElement): Rect {
  const flow = container.querySelector<HTMLElement>('.react-flow') ?? container
  const flowRect = flow.getBoundingClientRect()
  const bounds =
    flowRect.width > 0 && flowRect.height > 0 ? flowRect : container.getBoundingClientRect()
  const width = flow.clientWidth || container.clientWidth
  const height = flow.clientHeight || container.clientHeight
  let left = 16
  let top = 16
  let bottom = height - 16
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.right > bounds.left &&
      rect.left < bounds.right &&
      rect.bottom > bounds.top &&
      rect.top < bounds.bottom
      ? rect
      : undefined
  }
  for (const element of container.querySelectorAll('.studio-node-tools')) {
    const rect = visible(element)
    if (!rect) continue
    if (rect.width > rect.height) top = Math.max(top, rect.bottom - bounds.top + 16)
    else left = Math.max(left, rect.right - bounds.left + 16)
  }
  for (const element of container.querySelectorAll(
    '.studio-node-composer, .studio-node-navigation, .studio-node-chat',
  )) {
    const rect = visible(element)
    if (rect) bottom = Math.min(bottom, rect.top - bounds.top - 16)
  }
  const shell = container.closest('.studio-shell') ?? container
  for (const element of shell.querySelectorAll(
    '.studio-project-viewbar, .studio-node-project-title',
  )) {
    const rect = visible(element)
    if (rect) top = Math.max(top, rect.bottom - bounds.top + 16)
  }
  // 节点标题按屏幕尺寸画在卡片上方（.studio-node-caption 的 -30px），不在节点包围盒里。
  top += NODE_CAPTION_CLEARANCE
  return {
    x: left,
    y: top,
    width: Math.max(1, width - left - 16),
    height: Math.max(1, bottom - top),
  }
}

function viewportForCanvasBounds(
  bounds: Rect,
  container: HTMLElement | null,
  minZoom: number,
  maxZoom: number,
  padding: number,
) {
  if (!container?.clientWidth || !container.clientHeight) return null
  const area = availableCanvasArea(container)
  const viewport = getViewportForBounds(bounds, area.width, area.height, minZoom, maxZoom, padding)
  return { ...viewport, x: viewport.x + area.x, y: viewport.y + area.y }
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
  const projectId = useCanvasProjectStore(
    (state) =>
      state.projects.find(
        (project) => project.sceneKey === viewKey && project.cloud && !project.cloud.deleted,
      )?.id,
  )
  const snapshot = useDocumentSnapshot(canvas)
  useStoryboardGridSplitting(canvas, editor)
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
  const [scriptPoint, setScriptPoint] = useState<{ x: number; y: number } | null>(null)
  const [addingAsset, setAddingAsset] = useState(false)
  const assetTarget = useRef<string | undefined>(undefined)
  const [referencePick, setReferencePick] = useState<{
    targetId: string
    slot?: ReferenceSlot
    viewport: { x: number; y: number; zoom: number }
  } | null>(null)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const referenceInput = useRef<HTMLInputElement>(null)
  const uploadReferenceTarget = useRef<string | null>(null)
  const pickableIds = useMemo(
    () =>
      referencePick
        ? canvasReferenceCandidates(snapshot, referencePick.targetId, referencePick.slot)
        : new Set<string>(),
    [snapshot, referencePick],
  )
  useEffect(() => {
    if (referencePick && !snapshot.nodes.some((node) => node.id === referencePick.targetId)) {
      flowRef.current?.setViewport(referencePick.viewport)
      setReferencePick(null)
    }
  }, [snapshot.nodes, referencePick])
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
  useEffect(() => {
    setNodeCanvasSelection(editor, canvas, selectedIds.current)
    return () => clearNodeCanvasSelection(editor, canvas)
  }, [editor, canvas])
  const [batchIds, setBatchIds] = useState<string[] | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const connectStart = useRef<{ x: number; y: number } | null>(null)
  const [fileOver, setFileOver] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [textGeneration, setTextGeneration] = useState<
    Record<string, { busy: boolean; error: string | null }>
  >({})
  const textRequests = useMemo(() => new Map<string, AbortController>(), [canvas])
  useEffect(
    () => () => {
      for (const controller of textRequests.values()) controller.abort()
      textRequests.clear()
    },
    [textRequests],
  )
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  const [frame, setFrame] = useState({ x: 0, y: 0, zoom: 1, width: 0, height: 0 })
  const selectedRef = useRef<string | null>(null)
  const focusRef = useRef<NodeCanvasFocus>(() => false)
  const revealRef = useRef<NodeCanvasFocus>(() => false)
  const flowRef = useRef<{
    screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number }
    setViewport: (
      viewport: { x: number; y: number; zoom: number },
      options?: { duration?: number },
    ) => void
    getViewport: () => { x: number; y: number; zoom: number }
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
  const viewportItems = useMemo(() => {
    const boxes: CanvasViewportBox[] = []
    for (const group of snapshot.groups ?? []) {
      boxes.push({
        id: group.id,
        x: group.x,
        y: group.y,
        width: group.width,
        height: group.height,
      })
    }
    for (const node of snapshot.nodes) {
      boxes.push({
        id: node.id,
        x: node.x,
        y: node.y,
        ...nodeCardSize(node),
      })
    }
    for (const annotation of snapshot.annotations) {
      boxes.push({ id: annotation.id, ...annotationBounds(annotation) })
    }
    return boxes
  }, [snapshot])
  const pinnedIds = useMemo(() => {
    const ids = selectedId ? [selectedId] : []
    for (const id of draggingIds) if (id !== selectedId) ids.push(id)
    return ids
  }, [selectedId, draggingIds])
  const viewportPlan = useMemo(
    () =>
      planCanvasViewport({
        items: viewportItems,
        edges: snapshot.edges,
        frame,
        pinnedIds,
      }),
    [viewportItems, snapshot.edges, frame, pinnedIds],
  )
  // 总览不挂组成员。拖组时状态里的坐标已经跟着走，画布要用这份，不能等松手写回文档。
  const overviewItems = useMemo(
    () =>
      withLivePositions(
        viewportPlan.painted,
        new Map(nodes.map((node) => [node.id, node.position])),
      ),
    [viewportPlan.painted, nodes],
  )
  const framing = useRef<number | null>(null)
  const showFrame = (
    ids: readonly string[] | undefined,
    padding: number,
    minZoom: number,
    maxZoom: number,
    duration?: number,
    source: CanvasSnapshot = snapshot,
  ) => {
    const bounds = boundsOf(source, ids ? new Set(ids) : undefined, nodes)
    const viewport =
      bounds && viewportForCanvasBounds(bounds, container.current, minZoom, maxZoom, padding)
    if (!viewport) return
    if (framing.current !== null) {
      clearTimeout(framing.current)
      framing.current = null
    }
    flowRef.current?.setViewport(viewport, duration ? { duration } : undefined)
    framing.current = duration
      ? window.setTimeout(() => {
          framing.current = null
        }, duration + 100)
      : null
  }
  const revealBounds = (bounds: Rect): boolean => {
    const element = container.current
    const viewport = flowRef.current?.getViewport()
    if (!element?.clientWidth || !element.clientHeight || !viewport) return false
    const area = availableCanvasArea(element)
    const width = bounds.width * viewport.zoom
    const height = bounds.height * viewport.zoom
    const left = bounds.x * viewport.zoom + viewport.x
    const top = bounds.y * viewport.zoom + viewport.y
    const dx =
      width > area.width || left < area.x
        ? area.x - left
        : Math.min(0, area.x + area.width - left - width)
    const dy =
      height > area.height || top < area.y
        ? area.y - top
        : Math.min(0, area.y + area.height - top - height)
    if (dx || dy)
      flowRef.current?.setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy })
    return true
  }
  const revealNode = (target: CanvasNode) => {
    // Selection layout must not interrupt explicit focus animations.
    if (framing.current !== null) return
    revealBounds({ x: target.x, y: target.y, ...nodeCardSize(target) })
  }
  const chatVisible = Boolean(onChat)
  useEffect(() => {
    const element = container.current
    if (!element || !selectedId) return
    const reveal = () => {
      const node = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === selectedId)
      if (node) revealNode(node)
    }
    const observer = new ResizeObserver(reveal)
    observer.observe(element)
    for (const overlay of element.querySelectorAll(
      '.studio-node-composer, .studio-node-navigation, .studio-node-tools, .studio-node-chat',
    ))
      observer.observe(overlay)
    reveal()
    return () => observer.disconnect()
  }, [container, canvas.doc, selectedId, chatVisible])
  const selectNode = (next: string | null) => {
    selectedRef.current = next
    selectedIds.current = next ? [next] : []
    setNodeCanvasSelection(editor, canvas, selectedIds.current)
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
  const focus = (ids: readonly string[]): boolean => {
    const current = readCanvasDocument(canvas.doc)
    const available = new Set([
      ...current.nodes.map((node) => node.id),
      ...(current.groups ?? []).map((group) => group.id),
    ])
    const selected = ids.filter((id) => available.has(id))
    if (!selected.length) return false
    // Navigate to persisted geometry, not an uncommitted arrangement preview.
    setArrangement(null)
    const selectedSet = new Set(selected)
    const single = selected.length === 1 ? selected[0]! : null
    selectedRef.current = single
    selectedIds.current = [...selected]
    setNodeCanvasSelection(editor, canvas, selectedIds.current)
    setSelectedCount(selected.length)
    setSelectedId(single)
    setSelectedEdges([])
    setNodes((currentNodes) => {
      const additions = selected.flatMap((id) => {
        if (currentNodes.some((node) => node.id === id)) return []
        const node = current.nodes.find((one) => one.id === id)
        if (node) return [toFlowNode(node, true)]
        const group = current.groups?.find((one) => one.id === id)
        return group ? [toGroupFlowNode(group, true)] : []
      })
      return [
        ...currentNodes.map((node) => ({ ...node, selected: selectedSet.has(node.id) })),
        ...additions,
      ]
    })
    showFrame(selected, 0.3, 0.05, 1, 250, current)
    return true
  }
  focusRef.current = focus
  revealRef.current = (ids) => {
    const bounds = boundsOf(readCanvasDocument(canvas.doc), new Set(ids))
    if (!bounds) return false
    // Keep the current zoom and prevent invalidated preview cleanup restoring an older viewport.
    setArrangement(null)
    if (framing.current !== null) {
      clearTimeout(framing.current)
      framing.current = null
    }
    return revealBounds(bounds)
  }
  useEffect(() => {
    return registerNodeCanvasFocus(
      editor,
      (ids) => focusRef.current(ids),
      (ids) => revealRef.current(ids),
    )
  }, [editor, canvas])
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
    setNodeCanvasSelection(editor, canvas, ids)
    setSelectedCount(ids.length)
    setNodes((current) => [
      ...current
        .filter((node) => !chosen.has(node.id))
        .map((node) => ({ ...node, selected: false })),
      ...created.map((node) => toFlowNode(node, true)),
    ])
    const bounds = contentBounds({ nodes: created, edges: [], annotations: [] })
    const viewport =
      bounds &&
      viewportForCanvasBounds(bounds, container.current, 0.1, Math.min(1, frame.zoom), 0.3)
    if (viewport) flowRef.current?.setViewport(viewport)
  }
  useAgentNodeRun({
    canvas,
    editor,
    projectId,
    active,
    revision: snapshot,
    files,
  })
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
    showFrame(undefined, 0.25, 0.05, 8, 250)
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
    const viewport = bounds && viewportForCanvasBounds(bounds, container.current, 0.05, 1, 0.25)
    if (viewport) flowRef.current?.setViewport(viewport)
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
    const timelineSources =
      kind === 'timeline'
        ? snapshot.nodes
            .filter((n) => selectedIds.current.includes(n.id) && nodeKind(n) === 'video')
            .sort((a, b) => a.x - b.x || a.y - b.y)
            .map((n) => n.id)
        : []
    for (const anchor of menu?.anchorIds ?? timelineSources)
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
  const placeScript = (brief: ScriptBrief) => {
    const id = createNode(canvas, 'text', scriptPoint ?? placeAt.current, textFill, undefined, {
      name: brief.title,
      text: renderScriptDocument(brief),
    })
    setScriptPoint(null)
    selectNode(id)
  }
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
      if (referencePick) {
        if (event.key === 'Escape') {
          event.preventDefault()
          finishReferencePick()
        }
        return
      }
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
          '.react-flow__node, .react-flow__controls, .react-flow__minimap, .react-flow__handle, .studio-node-menu, .studio-node-composer, .studio-node-tools, .studio-node-navigation, textarea, input',
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
    selected.data.node.type !== 'timeline' &&
    selected.data.node.type !== 'storyboard'
      ? selected.data.node
      : undefined
  const textNode = selected?.data.node?.type === 'text' ? selected.data.node : undefined
  const [textDrafts, setTextDrafts] = useState<Record<string, string>>({})
  const textDraft = textNode ? (textDrafts[textNode.id] ?? '') : ''
  const referenceNode = selected?.data.node?.type !== 'timeline' ? selected?.data.node : undefined
  const rawReferences = referenceNode
    ? incomingReferences(snapshot.nodes, snapshot.edges, referenceNode.id)
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
    if (!node || node.type === 'text' || node.type === 'timeline' || node.type === 'storyboard')
      return
    const data = canvas.doc.getMap<Y.Map<unknown>>('nodes').get(node.id)?.get('data') as
      | ImageNodeData
      | undefined
    if (!data) return
    updateCanvasNode(
      canvas.doc,
      node.id,
      { data: { ...data, meta: { ...data.meta, ...patch } } },
      trackUndo ? canvas.origin : canvasOrigin('system', 'node-defaults'),
    )
  }
  const startReferencePick = (slot?: ReferenceSlot) => {
    if (!referenceNode) return
    setReferencePick({
      targetId: referenceNode.id,
      slot,
      viewport: referencePick?.viewport ?? flowRef.current?.getViewport() ?? frame,
    })
    closeMenu()
    fit()
  }
  const finishReferencePick = () => {
    if (referencePick) flowRef.current?.setViewport(referencePick.viewport)
    setReferencePick(null)
  }
  const uploadReference = async (targetId: string, file: File, slot?: ReferenceSlot) => {
    setReferenceBusy(true)
    try {
      await uploadCanvasReference(editor, canvas, targetId, file, slot)
    } catch (error) {
      useStore
        .getState()
        .showToast(
          error instanceof CanvasReferenceLimitError
            ? MAX_INPUT_IMAGES_MESSAGE
            : t('import.failed'),
          'error',
        )
    } finally {
      setReferenceBusy(false)
    }
  }
  const referenceTools = referenceNode ? (
    <NodeReferenceEditor
      references={references}
      files={files}
      disabled={referenceBusy}
      onPick={() => startReferencePick()}
      onUpload={() => {
        uploadReferenceTarget.current = referenceNode.id
        referenceInput.current?.click()
      }}
      onAssets={() => {
        assetTarget.current = referenceNode.id
        setAssetsOpen(true)
      }}
      onRemove={(id) => {
        const edge = snapshot.edges.find((e) => e.source === id && e.target === referenceNode.id)
        if (edge) disconnectCanvasNodes(canvas.doc, edge.id, canvas.origin)
      }}
      onMove={
        composerNode
          ? (id) => {
              const ids = references.map((r) => r.id)
              const at = ids.indexOf(id)
              if (at > 0) [ids[at - 1], ids[at]] = [ids[at]!, ids[at - 1]!]
              setMeta({ referenceOrder: JSON.stringify(ids) })
            }
          : undefined
      }
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
  const generateSelectedText = async (model: string) => {
    if (!textNode || textRequests.has(textNode.id)) return
    const nodeId = textNode.id
    const instruction = textDraft.trim()
    if (!instruction) return
    const originalText = textNode.data.text
    const originalRichText = JSON.stringify(textNode.data.richText)
    const controller = new AbortController()
    textRequests.set(nodeId, controller)
    setTextGeneration((current) => ({ ...current, [nodeId]: { busy: true, error: null } }))
    try {
      const result = await generateTextNode({
        model,
        instruction,
        currentText: originalText,
        references: references.map((reference) => ({
          id: reference.id,
          kind: reference.kind,
          ...(reference.label ? { label: reference.label } : {}),
          ...(reference.text ? { text: reference.text } : {}),
        })),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const current = readCanvasDocument(canvas.doc).nodes.find((node) => node.id === nodeId)
      if (!current || current.type !== 'text') return
      if (
        current.data.text !== originalText ||
        JSON.stringify(current.data.richText) !== originalRichText
      ) {
        throw new Error('text_generation_content_changed')
      }
      canvas.undo.stopCapturing()
      canvas.doc.transact(() => {
        const text = canvasText(canvas.doc, nodeId)
        if (text) {
          text.delete(0, text.length)
          text.insert(0, `${result}\n`)
        }
        updateCanvasNode(
          canvas.doc,
          nodeId,
          { data: { ...current.data, text: result, richText: undefined } },
          canvas.origin,
        )
      }, canvas.origin)
      canvas.undo.stopCapturing()
      setTextDrafts((drafts) => ({ ...drafts, [nodeId]: '' }))
      setTextGeneration((states) => ({ ...states, [nodeId]: { busy: false, error: null } }))
    } catch (error) {
      if (!controller.signal.aborted) {
        setTextGeneration((states) => ({
          ...states,
          [nodeId]: {
            busy: false,
            error: error instanceof Error ? error.message : 'text_generation_failed',
          },
        }))
      }
    } finally {
      textRequests.delete(nodeId)
      setTextGeneration((states) =>
        states[nodeId]?.busy ? { ...states, [nodeId]: { busy: false, error: null } } : states,
      )
    }
  }
  const uploadInto = (id: string, file: File) => {
    void fillImageNode(editor, canvas.doc, id, file).catch(() =>
      useStore.getState().showToast(t('import.failed'), 'error'),
    )
  }
  const spawnBeside = (nodeId: string, side: 'left' | 'right') => {
    const node = snapshot.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const ids = selectedIds.current.includes(nodeId) ? selectedIds.current : [nodeId]
    const { width, height } = nodeCardSize(node)
    placeAt.current = {
      x: node.x + (side === 'right' ? width + 32 : -32),
      y: node.y + height / 2,
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
  const overview = viewportPlan.mode === 'overview'
  const mounted = overview ? new Set(viewportPlan.mountedIds) : null
  return (
    <NodeStoryboardContext.Provider value={{ canvas, snapshot, onRun: setBatchIds }}>
      <NodeTimelineContext.Provider
        value={{
          editor,
          snapshot,
          onPick: (id) => {
            selectNode(id)
            setReferencePick({ targetId: id, viewport: flowRef.current?.getViewport() ?? frame })
            fit()
          },
          onLocate: (id) => {
            selectNode(id)
            showFrame([id], 0.5, 0.2, 1, 250)
          },
        }}
      >
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
                      <CanvasLodProvider mode={viewportPlan.mode === 'card' ? 'card' : 'detail'}>
                        <ReactFlow<FlowNode>
                          style={{ '--studio-node-zoom': frame.zoom } as CSSProperties}
                          nodes={(mounted
                            ? nodes.filter((node) => mounted.has(node.id))
                            : nodes
                          ).map((node) => {
                            if (referencePick)
                              return {
                                ...node,
                                className: pickableIds.has(node.id)
                                  ? 'studio-node-reference-eligible'
                                  : 'studio-node-reference-disabled',
                              }
                            const position = arrangementPositions.get(node.id)
                            return position ? { ...node, position } : node
                          })}
                          className={
                            arrangementActive
                              ? 'studio-node-arranging'
                              : referencePick
                                ? 'studio-node-reference-picking'
                                : undefined
                          }
                          nodesDraggable={!arrangementActive && !referencePick}
                          nodesConnectable={!arrangementActive && !referencePick}
                          elementsSelectable={!arrangementActive && !referencePick}
                          onlyRenderVisibleElements={!overview && !arrangementActive}
                          edges={snapshot.edges.flatMap((edge) => {
                            if (mounted && (!mounted.has(edge.source) || !mounted.has(edge.target)))
                              return []
                            return [
                              {
                                id: edge.id,
                                type: 'reference',
                                source: edge.source,
                                target: edge.target,
                                interactionWidth: 22,
                                hidden: !connections && !referencePick,
                                selected: selectedEdges.includes(edge.id),
                                className: highlightedEdges.has(edge.id)
                                  ? 'studio-edge-lit'
                                  : undefined,
                                zIndex: highlightedEdges.has(edge.id) ? 1 : 0,
                              },
                            ]
                          })}
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
                          selectionOnDrag={mode === 'select' && !referencePick}
                          selectionMode={SelectionMode.Partial}
                          panOnDrag={mode === 'pan' ? true : [1, 2]}
                          panOnScroll
                          zoomOnScroll={false}
                          multiSelectionKeyCode="Shift"
                          onSelectionChange={({ nodes: selected }) => {
                            if (arrangementActive || referencePick || overview) return
                            const ids = selected
                              .filter((n) => n.data.node || n.data.group)
                              .map((n) => n.id)
                            selectedIds.current = ids
                            setNodeCanvasSelection(editor, canvas, ids)
                            if (ids.length)
                              setSelectedEdges((current) => (current.length ? [] : current))
                            setSelectedCount(ids.length)
                            const id = ids.length === 1 ? ids[0]! : null
                            selectedRef.current = id
                            setSelectedId(id)
                          }}
                          onPaneContextMenu={(event) => {
                            event.preventDefault()
                            if (referencePick) return
                            placeAt.current =
                              flowRef.current?.screenToFlowPosition({
                                x: event.clientX,
                                y: event.clientY,
                              }) ?? center()
                            setMenu({ x: event.clientX, y: event.clientY })
                          }}
                          onNodeClick={(event, node) => {
                            if (referencePick) {
                              event.stopPropagation()
                              if (
                                addCanvasReference(
                                  canvas,
                                  referencePick.targetId,
                                  node.id,
                                  referencePick.slot,
                                ) &&
                                referencePick.slot
                              )
                                finishReferencePick()
                              return
                            }
                            if (arrangementActive) return
                            if (!event.shiftKey && node.data.node) revealNode(node.data.node)
                          }}
                          onNodeContextMenu={(event, node) => {
                            event.preventDefault()
                            if (arrangementActive || referencePick) return
                            if (!selectedIds.current.includes(node.id)) selectNode(node.id)
                            placeAt.current = center()
                            setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id })
                          }}
                          onEdgeClick={(event, edge) => {
                            event.stopPropagation()
                            if (referencePick) return
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
                              // 总览把没钉住的节点从 React Flow 拿掉。忽略随之而来的删除和取消选择，状态里仍留着整份画布。
                              const applicable = overview
                                ? changes.filter(
                                    (change) =>
                                      change.type !== 'remove' && change.type !== 'select',
                                  )
                                : changes
                              const next = applyNodeChanges(applicable, current)
                              const changed = new Set(
                                applicable
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
                            if (referencePick) return
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
                          onNodeDragStart={(_event, _node, dragged) => {
                            canvas.undo.stopCapturing()
                            setDraggingIds(dragged.map((node) => node.id))
                          }}
                          onNodeDragStop={(_event, _node, dragged) => {
                            setDraggingIds([])
                            const groups = dragged.filter((one) => one.data.group)
                            const members = new Set(
                              groups.flatMap((one) => one.data.group!.members),
                            )
                            const free = dragged.filter(
                              (one) => one.data.node && !members.has(one.id),
                            )
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
                                safeLocalStorage.getItem(
                                  scopedStorageName(`node-viewport:${viewKey}`),
                                ) ?? 'null',
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
                            else if (bounds) {
                              const viewport = viewportForCanvasBounds(bounds, box, 0.05, 1, 0.1)
                              if (viewport) flow.setViewport(viewport)
                            }
                            remember(flow.getViewport())
                          }}
                          deleteKeyCode={null}
                          proOptions={{ hideAttribution: true }}
                        >
                          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
                          {minimap && !overview && (
                            <MiniMap pannable zoomable position="bottom-right" />
                          )}
                        </ReactFlow>
                        <CanvasOverview
                          active={overview}
                          container={container}
                          items={overviewItems}
                          edges={snapshot.edges}
                          frame={frame}
                          mountedIds={viewportPlan.mountedIds}
                        />
                      </CanvasLodProvider>
                      {referencePick && (
                        <div className="studio-node-pick-banner" role="status">
                          <Icon name="fit" /> <span>{t('nodes.pickFromCanvas')}</span>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('nodes.finishPicking')}
                            onClick={finishReferencePick}
                          >
                            <Icon name="close" />
                          </Button>
                        </div>
                      )}
                      <NodeCanvasToolbar
                        onCreate={(kind) => {
                          finishReferencePick()
                          addNode(kind, center())
                        }}
                        onMenu={openMenu}
                        onAssets={() => {
                          assetTarget.current = undefined
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
                      {batchIds && (
                        <NodeBatchDialog
                          canvas={canvas}
                          editor={editor}
                          ids={batchIds}
                          snapshot={snapshot}
                          onClose={() => {
                            setBatchIds(null)
                          }}
                        />
                      )}
                      {selected?.data.group && (
                        <div className="studio-node-selection-bar text-label-md">
                          <span>{selected.data.group.name}</span>
                          <NodeTool
                            icon="play"
                            label={t('nodeBatch.run')}
                            onClick={() => setBatchIds([...selectedIds.current])}
                          />
                          <NodeTool icon="folder" label={t('nodes.ungroup')} onClick={ungroup} />
                          <NodeTool
                            icon="duplicate"
                            label={t('nodes.duplicate')}
                            onClick={duplicate}
                          />
                        </div>
                      )}
                      {selectedCount > 1 && (
                        <div className="studio-node-selection-bar text-label-md">
                          <span>{t('nodes.selectedCount', { count: selectedCount })}</span>
                          <NodeTool
                            icon="play"
                            label={t('nodeBatch.run')}
                            onClick={() => setBatchIds([...selectedIds.current])}
                          />
                          <NodeTool icon="folder" label={t('nodes.group')} onClick={makeGroup} />
                          <NodeTool
                            icon="add"
                            label={t('nodes.newFromSelection')}
                            onClick={() =>
                              spawnBeside(
                                selectedIds.current[selectedIds.current.length - 1]!,
                                'right',
                              )
                            }
                          />
                          <NodeTool
                            icon="duplicate"
                            label={t('nodes.duplicate')}
                            onClick={duplicate}
                          />
                          <NodeTool icon="delete" label={t('nodes.delete')} onClick={remove} />
                        </div>
                      )}
                      {scriptPoint && (
                        <ScriptBriefDialog
                          onClose={() => setScriptPoint(null)}
                          onConfirm={placeScript}
                        />
                      )}
                      {assetsOpen && (
                        <NodeAssetPicker
                          onClose={() => {
                            setAssetsOpen(false)
                            assetTarget.current = undefined
                          }}
                          onChoose={(asset, imageId) => {
                            setAssetsOpen(false)
                            const targetId = assetTarget.current
                            assetTarget.current = undefined
                            void addAsset(asset, imageId, placeAt.current, targetId)
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
                      <TimelineEditorHost
                        editor={editor}
                        onLocate={(id) => {
                          selectNode(id)
                          showFrame([id], 0.5, 0.2, 1, 250)
                        }}
                        beginEdit={(id) => {
                          const draft = beginCanvasTimelineEdit(canvas.doc, id, canvas.origin)
                          return {
                            clips: draft.clips,
                            save: (clips) => {
                              canvas.undo.stopCapturing()
                              draft.save(clips)
                            },
                          }
                        }}
                      />
                      <FilmExportStatus />
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
                                  let stage: 'original' | 'fetch' | 'blob' | 'trigger' = 'original'
                                  void resolveMediaSource(source, 'original', true)
                                    .then((url) => {
                                      stage = 'fetch'
                                      return fetch(url, { credentials: 'include' })
                                    })
                                    .then(async (response) => {
                                      if (!response.ok) throw new Error('download failed')
                                      stage = 'blob'
                                      const blob = await response.blob()
                                      const extension =
                                        blob.type.split('/')[1]?.split(';')[0] ||
                                        (composerNode.type === 'video' ? 'mp4' : 'png')
                                      const name = composerNode.data.name || 'muvloom'
                                      stage = 'trigger'
                                      downloadBlob(
                                        blob,
                                        /\.(png|jpe?g|webp|avif|gif|mp4|webm)$/i.test(name)
                                          ? name
                                          : `${name}.${extension}`,
                                      )
                                    })
                                    .catch((error: unknown) => {
                                      reportDeliveryFailure(
                                        { operation: 'download.prepare', stage },
                                        error,
                                      )
                                      useStore.getState().showToast(t('import.failed'), 'error')
                                    })
                                } else {
                                  reportDeliveryFailure(
                                    { operation: 'download.prepare', stage: 'original' },
                                    { code: 'original_missing' },
                                  )
                                }
                              }}
                            />
                            {composerNode.type === 'image' &&
                              nodeKind(composerNode) === 'image' && (
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
                            {composerNode.type === 'image' &&
                              nodeKind(composerNode) === 'image' && (
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
                        ref={referenceInput}
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={async (event) => {
                          const files = [...(event.target.files ?? [])]
                          event.target.value = ''
                          const targetId = uploadReferenceTarget.current
                          uploadReferenceTarget.current = null
                          if (targetId)
                            for (const file of files) await uploadReference(targetId, file)
                        }}
                      />
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
                          disabledKinds={(
                            ['text', 'image', 'video', 'timeline', 'storyboard'] as const
                          ).filter((kind) => !canAddKind(kind))}
                          x={menu.x}
                          y={menu.y}
                          onClose={closeMenu}
                          onText={() => addNode('text')}
                          onImage={() => addNode('image')}
                          onVideo={() => addNode('video')}
                          onTimeline={() => addNode('timeline')}
                          onStoryboard={() => addNode('storyboard')}
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
                                                  .showToast(
                                                    t('nodes.candidateUnavailable'),
                                                    'error',
                                                  ),
                                              )
                                          },
                                        },
                                      ]
                                    : []),
                                  {
                                    icon: 'folder',
                                    label: t(
                                      selected?.data.group ? 'nodes.ungroup' : 'nodes.group',
                                    ),
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
                              : [
                                  ...(!menu.beside
                                    ? [
                                        {
                                          icon: 'notebook' as const,
                                          label: t('scriptBrief.open'),
                                          onClick: () => {
                                            const point = placeAt.current
                                            closeMenu()
                                            setScriptPoint(point)
                                          },
                                        },
                                      ]
                                    : []),
                                  ...(copied.current
                                    ? [
                                        {
                                          icon: 'copy' as const,
                                          label: t('nodes.paste'),
                                          onClick: () => {
                                            const ids = pasteNodes(
                                              canvas,
                                              copied.current!,
                                              placeAt.current,
                                            )
                                            selectNode(ids[0] ?? null)
                                            closeMenu()
                                          },
                                        },
                                      ]
                                    : []),
                                ]
                          }
                          onUpload={() => {
                            closeMenu()
                            fileInput.current?.click()
                          }}
                        />
                      )}
                      {textNode && selected && (
                        <TextNodeComposer
                          key={textNode.id}
                          references={references}
                          files={files}
                          value={textDraft}
                          tools={referenceTools}
                          busy={textGeneration[textNode.id]?.busy}
                          error={textGeneration[textNode.id]?.error}
                          onChange={(value) =>
                            setTextDrafts((drafts) => ({ ...drafts, [textNode.id]: value }))
                          }
                          onSubmit={(model) => void generateSelectedText(model)}
                        />
                      )}
                      {composerNode && nodeKind(composerNode) === 'image' && (
                        <ImageNodeComposer
                          templates
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
                                busy={busy || addingAsset || referenceBusy}
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
                          onReferenceUpload={(file, slot) =>
                            uploadReference(composerNode.id, file, slot)
                          }
                          referenceTools={referenceTools}
                          references={references}
                          files={files}
                          value={draftValue}
                          busy={busy || addingAsset || referenceBusy}
                          onChange={(value) => {
                            setMeta({ nodePrompt: value })
                          }}
                          onSubmit={(temporaryReferences) => {
                            const look = useActiveLook.getState().look
                            if (look) {
                              void submitNodeWithLook(
                                editor,
                                canvas.doc,
                                composerNode.id,
                                look,
                                draftValue,
                                references,
                                files,
                              )
                              return
                            }
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
                      {composerNode && nodeKind(composerNode) === 'video' && (
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
                          onPickReference={startReferencePick}
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
                          busy={busy || addingAsset || referenceBusy}
                          onReferenceUpload={(file, slot) =>
                            uploadReference(composerNode.id, file, slot)
                          }
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
      </NodeTimelineContext.Provider>
    </NodeStoryboardContext.Provider>
  )
}

/** 节点画布：一个项目的 `Y.Doc` 渲染成 React Flow。 */
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
    const controller = new AbortController()
    setCanvas(null)
    setFailed(false)
    void openLocalNodeCanvas(key, workspace.editor, controller.signal)
      .then((one) => {
        if (one && !controller.signal.aborted) setCanvas(one)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
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
