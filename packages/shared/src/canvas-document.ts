import * as Y from 'yjs'
import type {
  ProjectElement,
  ProjectGeneration,
  ProjectImage,
  ProjectTimeline,
  ProjectVideoRef,
} from './project-protocol'

/**
 * 项目画布的文档模型（ADR 0023）：一个 `Y.Doc`，浏览器与服务端共用这一份读写规则。
 * 调用方只经这里的函数读写，不直接碰 Yjs 结构。
 */

export const CANVAS_NODE_TYPES = ['text', 'image', 'video', 'timeline'] as const
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number]

export type CanvasAnnotationType = 'arrow' | 'freedraw'

/** 还在跑或已失败的生成：原记录整份保留，任务续跑与失败出路照旧认它。 */
export type PendingGeneration =
  | Omit<ProjectGeneration, 'id' | 'x' | 'y' | 'width' | 'height'>
  | Omit<LegacyPlaceholder, 'id' | 'x' | 'y' | 'width' | 'height'>

export interface ImageNodeData {
  /** 本机位图用 `fileId`，云端用 `mediaId`。 */
  fileId?: string
  mediaId?: string
  rotation?: number
  name?: string
  naturalWidth?: number
  naturalHeight?: number
  createdAt?: number
  groupId?: string
  meta?: Record<string, string>
  pending?: PendingGeneration
}

export interface VideoNodeData extends ImageNodeData {
  video: ProjectVideoRef
}

export interface TextNodeData {
  text: string
  fontSize: number
  fill: string
}

export interface TimelineNodeData {
  clips: ProjectTimeline['clips']
}

interface CanvasNodeBase {
  id: string
  x: number
  y: number
  width: number
  height: number
  /** 叠放次序，越大越靠上；节点与标注共用一条序列。 */
  z: number
}

export type CanvasNode = CanvasNodeBase &
  (
    | { type: 'image'; data: ImageNodeData }
    | { type: 'video'; data: VideoNodeData }
    | { type: 'text'; data: TextNodeData }
    | { type: 'timeline'; data: TimelineNodeData }
  )

export interface CanvasAnnotation {
  id: string
  type: CanvasAnnotationType
  z: number
  points: number[]
  stroke: string
  strokeWidth: number
}

export interface CanvasSnapshot {
  nodes: CanvasNode[]
  annotations: CanvasAnnotation[]
}

interface LegacyPlaceholder {
  id: string
  type: 'placeholder'
  x: number
  y: number
  width: number
  height: number
  status: string
  message: string
  meta: object
}

/** 本机存档里的元素：位图用 `fileId`，运行中的任务是 `placeholder`。 */
export type LegacyCanvasElement =
  | Exclude<ProjectElement, ProjectImage>
  | (Omit<ProjectImage, 'mediaId'> & ({ mediaId: string } | { fileId: string }))
  | LegacyPlaceholder

/** 改动的发起人，撤销按它分组。用字符串：Yjs 按值比较才认得出同一个发起人。 */
export type CanvasOrigin = `${'user' | 'agent' | 'system'}:${string}`

export function canvasOrigin(kind: 'user' | 'agent' | 'system', id: string): CanvasOrigin {
  return `${kind}:${id}`
}

function nodesOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes')
}

function annotationsOf(doc: Y.Doc): Y.Map<CanvasAnnotation> {
  return doc.getMap('annotations')
}

/** 节点按写入顺序给出；叠放看 `z`。标注按 `z` 排好，绘制层直接按序画。 */
export function readCanvasDocument(doc: Y.Doc): CanvasSnapshot {
  const nodes = [...nodesOf(doc).values()].map((map) => map.toJSON() as CanvasNode)
  const annotations = [...annotationsOf(doc).values()].sort((a, b) => a.z - b.z)
  return { nodes, annotations }
}

// 几何是逐字段可合并的；`data` 先整块存，按节点能力逐步换成细粒度的 Yjs 类型。
function writeNode(doc: Y.Doc, node: CanvasNode): void {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(node)) map.set(key, value)
  nodesOf(doc).set(node.id, map)
}

function toNode(element: LegacyCanvasElement, z: number): CanvasNode | CanvasAnnotation {
  switch (element.type) {
    case 'arrow':
    case 'freedraw':
      return { ...element, points: [...element.points], z }
    case 'image': {
      const { id, x, y, width, height, type: _type, ...data } = element
      const base = { id, x, y, width, height, z }
      return data.video
        ? { ...base, type: 'video', data: { ...data, video: data.video } }
        : { ...base, type: 'image', data }
    }
    case 'text': {
      const { id, x, y, width, height, type: _type, ...data } = element
      return { id, x, y, width, height, z, type: 'text', data }
    }
    case 'timeline': {
      const { id, x, y, width, height, type: _type, ...data } = element
      return { id, x, y, width, height, z, type: 'timeline', data }
    }
    case 'placeholder':
    case 'generation': {
      // 运行中或失败的生成在节点画布里是还没有结果的图片节点。
      const { id, x, y, width, height, ...pending } = element
      return { id, x, y, width, height, z, type: 'image', data: { pending } }
    }
  }
}

/** 转换专用的 Yjs 客户端号。真实客户端号是 32 位随机数，0 不会被占用。 */
const LEGACY_IMPORT_CLIENT_ID = 0

/**
 * 把旧存档的元素搬进文档。转换只发生一次，之后以 `Y.Doc` 为准，旧存档原样留着。
 *
 * 两个副本可能同时转换同一份存档（双挂载、多标签页）。转换固定在同一个客户端号下按同样顺序写，
 * 同一份存档产出逐字节相同的更新，合并时去重；否则同 id 的节点会互相覆盖，后来的编辑可能落在输掉的那份上。
 * 因此同一个文档只能拿同一份存档来转换。
 */
export function importLegacyElements(
  doc: Y.Doc,
  elements: readonly LegacyCanvasElement[],
  origin: CanvasOrigin,
): void {
  if (doc.getMap('meta').get('legacyImported')) return
  const staging = new Y.Doc()
  staging.clientID = LEGACY_IMPORT_CLIENT_ID
  staging.transact(() => {
    // 以标记而不是「文档为空」判断转换过没有：转换结果为空、或之后被清空的画布不能再导一次。
    staging.getMap('meta').set('legacyImported', true)
    elements.forEach((element, z) => {
      const item = toNode(element, z)
      if ('points' in item) annotationsOf(staging).set(item.id, item)
      else writeNode(staging, item)
    })
  })
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(staging), origin)
  staging.destroy()
}

export function moveCanvasNodes(
  doc: Y.Doc,
  moves: readonly { id: string; x: number; y: number }[],
  origin: CanvasOrigin,
): void {
  const nodes = nodesOf(doc)
  doc.transact(() => {
    for (const move of moves) {
      const node = nodes.get(move.id)
      if (!node) continue
      if (node.get('x') !== move.x) node.set('x', move.x)
      if (node.get('y') !== move.y) node.set('y', move.y)
    }
  }, origin)
}

/** 只撤销 `origin` 自己的改动；一次调用是一步，连续拖动在合并窗口内也算一步。 */
export function createCanvasUndoManager(doc: Y.Doc, origin: CanvasOrigin): Y.UndoManager {
  return new Y.UndoManager([nodesOf(doc), annotationsOf(doc)], {
    trackedOrigins: new Set([origin]),
    captureTimeout: 300,
  })
}
