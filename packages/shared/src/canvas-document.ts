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

/**
 * 把旧存档的元素搬进文档。转换只发生一次，之后以 `Y.Doc` 为准，旧存档原样留着。
 * 持久化层须串行决定首次迁移者；保留 Yjs 客户端身份，避免不同快照复用同一组操作 ID。
 */
export function importLegacyElements(
  doc: Y.Doc,
  elements: readonly LegacyCanvasElement[],
  origin: CanvasOrigin,
): void {
  if (doc.getMap('meta').get('legacyImported')) return
  doc.transact(() => {
    // 以标记而不是「文档为空」判断转换过没有：转换结果为空、或之后被清空的画布不能再导一次。
    doc.getMap('meta').set('legacyImported', true)
    elements.forEach((element, z) => {
      const item = toNode(element, z)
      if ('points' in item) annotationsOf(doc).set(item.id, item)
      else writeNode(doc, item)
    })
  }, origin)
}

function sameField(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isPending(node: CanvasNode): boolean {
  return 'pending' in node.data && Boolean(node.data.pending)
}

const GEOMETRY_FIELDS = new Set(['x', 'y', 'width', 'height'])

/** 过渡期只接旧编辑器的真实增量；未变的几何不能盖掉用户在节点画布上的拖动。 */
export function synchronizeLegacyElements(
  doc: Y.Doc,
  previous: readonly LegacyCanvasElement[],
  next: readonly LegacyCanvasElement[],
  origin: CanvasOrigin,
): void {
  if (previous === next) return
  const before = new Map(previous.map((element, z) => [element.id, toNode(element, z)]))
  const after = new Map(next.map((element, z) => [element.id, toNode(element, z)]))
  const nodes = nodesOf(doc)
  const annotations = annotationsOf(doc)
  doc.transact(() => {
    for (const id of before.keys()) {
      if (after.has(id)) continue
      nodes.delete(id)
      annotations.delete(id)
    }
    for (const [id, item] of after) {
      const old = before.get(id)
      if (old && sameField(old, item)) continue
      if ('points' in item) {
        if (old && !('points' in old)) nodes.delete(id)
        const current = annotations.get(id)
        if (!old || !('points' in old) || !current) annotations.set(id, item)
        else {
          const updated = { ...current }
          for (const field of Object.keys(item) as (keyof CanvasAnnotation)[]) {
            if (!sameField(old[field], item[field]))
              Object.assign(updated, { [field]: item[field] })
          }
          if (!sameField(current, updated)) annotations.set(id, updated)
        }
        continue
      }
      if (old && 'points' in old) annotations.delete(id)
      const current = nodes.get(id)
      if (!current) {
        writeNode(doc, item)
        continue
      }
      const beforeNode = old && !('points' in old) ? old : undefined
      const preserveGeometry =
        !beforeNode ||
        (isPending(beforeNode) && !isPending(item)) ||
        (beforeNode.type === 'image' && item.type === 'video')
      for (const field of Object.keys(item) as (keyof CanvasNode)[]) {
        if (preserveGeometry && GEOMETRY_FIELDS.has(field)) continue
        if (
          (!beforeNode || !sameField(beforeNode[field], item[field])) &&
          !sameField(current.get(field), item[field])
        )
          current.set(field, item[field])
      }
    }
  }, origin)
}

/** 重开时仅补旧编辑器新增内容与任务终态，节点文档自己的几何和额外节点仍是正本。 */
export function reconcileLegacyElements(
  doc: Y.Doc,
  current: readonly LegacyCanvasElement[],
  origin: CanvasOrigin,
): void {
  const nodes = nodesOf(doc)
  const annotations = annotationsOf(doc)
  doc.transact(() => {
    current.forEach((element, z) => {
      const item = toNode(element, z)
      if (!nodes.has(item.id) && !annotations.has(item.id)) {
        if ('points' in item) annotations.set(item.id, item)
        else writeNode(doc, item)
        return
      }
      if ('points' in item) return
      const node = nodes.get(item.id)
      if (!node) return
      const data = node.get('data') as ImageNodeData | undefined
      if (!data?.pending) return
      const pending = 'pending' in item.data ? item.data.pending : undefined
      const settled =
        !pending ||
        (pending.type === 'generation'
          ? Boolean(pending.errorCode)
          : pending.status === 'error' || pending.status === 'stale')
      if (settled) {
        if (node.get('type') !== item.type) node.set('type', item.type)
        if (!sameField(data, item.data)) node.set('data', item.data)
      }
    })
  }, origin)
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
