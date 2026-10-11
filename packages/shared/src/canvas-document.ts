import * as Y from 'yjs'
import type { ProjectElement, ProjectImage } from './project-protocol'

/**
 * 项目画布的文档模型（ADR 0023）：一个 `Y.Doc`，浏览器与服务端共用这一份读写规则。
 * 调用方只经这里的函数读写，不直接碰 Yjs 结构。
 */

export const CANVAS_NODE_TYPES = ['text', 'image', 'video', 'timeline'] as const
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number]

export type CanvasAnnotationType = 'arrow' | 'freedraw'

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  x: number
  y: number
  width: number
  height: number
  /** 叠放次序，越大越靠上；节点与标注共用一条序列。 */
  z: number
  data: Record<string, unknown>
}

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

/** 本机存档里的元素：位图用 `fileId`，运行中的任务是 `placeholder`。 */
export type LegacyCanvasElement =
  | Exclude<ProjectElement, ProjectImage>
  | (Omit<ProjectImage, 'mediaId'> & ({ mediaId: string } | { fileId: string }))
  | {
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

/**
 * 改动的发起人。Yjs 按对象身份比较 origin，同一个发起人必须拿到同一个对象，
 * 撤销才认得出「这是我的改动」。
 */
export interface CanvasOrigin {
  readonly kind: 'user' | 'agent' | 'system'
  readonly id: string
}

const origins = new Map<string, CanvasOrigin>()

export function canvasOrigin(kind: CanvasOrigin['kind'], id: string): CanvasOrigin {
  const key = `${kind}:${id}`
  let origin = origins.get(key)
  if (!origin) {
    origin = Object.freeze({ kind, id })
    origins.set(key, origin)
  }
  return origin
}

function nodesOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes')
}

function annotationsOf(doc: Y.Doc): Y.Map<CanvasAnnotation> {
  return doc.getMap('annotations')
}

function readNode(map: Y.Map<unknown>): CanvasNode {
  return {
    id: map.get('id') as string,
    type: map.get('type') as CanvasNodeType,
    x: map.get('x') as number,
    y: map.get('y') as number,
    width: map.get('width') as number,
    height: map.get('height') as number,
    z: map.get('z') as number,
    data: (map.get('data') as Record<string, unknown>) ?? {},
  }
}

export function readCanvasDocument(doc: Y.Doc): CanvasSnapshot {
  const nodes = [...nodesOf(doc).values()].map(readNode).sort((a, b) => a.z - b.z)
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
    case 'image':
    case 'text':
    case 'timeline': {
      const { id, x, y, width, height, ...data } = element
      const type = element.type === 'image' && element.video ? 'video' : element.type
      return { id, type, x, y, width, height, z, data }
    }
    case 'placeholder':
    case 'generation': {
      // 运行中或失败的生成在节点画布里是还没有结果的图片节点；原记录整份保留，任务续跑与失败出路照旧认它。
      const { id, x, y, width, height, ...pending } = element
      return { id, type: 'image', x, y, width, height, z, data: { pending } }
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
      if (item.type === 'arrow' || item.type === 'freedraw') {
        annotationsOf(staging).set(item.id, item as CanvasAnnotation)
      } else writeNode(staging, item as CanvasNode)
    })
  })
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(staging), origin)
  staging.destroy()
}

/** 转换的反面：按叠放次序还原成旧存档的元素，用来核对转换没有丢东西。 */
export function exportLegacyElements(doc: Y.Doc): LegacyCanvasElement[] {
  const { nodes, annotations } = readCanvasDocument(doc)
  const items: (CanvasNode | CanvasAnnotation)[] = [...nodes, ...annotations].sort(
    (a, b) => a.z - b.z,
  )
  return items.map((item) => {
    if (item.type === 'arrow' || item.type === 'freedraw') {
      const { z: _z, ...annotation } = item as CanvasAnnotation
      return annotation as LegacyCanvasElement
    }
    const { id, type, x, y, width, height, data } = item as CanvasNode
    const pending = data.pending as Record<string, unknown> | undefined
    if (pending) return { id, x, y, width, height, ...pending } as LegacyCanvasElement
    const legacyType = type === 'video' ? 'image' : type
    return { id, type: legacyType, x, y, width, height, ...data } as LegacyCanvasElement
  })
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
