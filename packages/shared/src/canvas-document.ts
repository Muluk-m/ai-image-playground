import * as Y from 'yjs'
import type { ProjectElement, ProjectImage } from './project-protocol'

/**
 * 项目画布的文档模型（ADR 0023）：一个 `Y.Doc`，浏览器与服务端共用这一份读写规则。
 * 调用方只经这里的函数读写，不直接碰 Yjs 结构。
 */

export const CANVAS_NODE_TYPES = ['text', 'image', 'video', 'timeline'] as const
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number]

export const CANVAS_ANNOTATION_TYPES = ['arrow', 'freedraw'] as const
export type CanvasAnnotationType = (typeof CANVAS_ANNOTATION_TYPES)[number]

/** 节点注册表：每种节点的默认尺寸。连线规则、输入框与工具条随后续节点能力加进来。 */
export const CANVAS_NODE_REGISTRY: Readonly<
  Record<CanvasNodeType, { readonly defaultWidth: number; readonly defaultHeight: number }>
> = {
  text: { defaultWidth: 320, defaultHeight: 160 },
  image: { defaultWidth: 320, defaultHeight: 320 },
  video: { defaultWidth: 320, defaultHeight: 180 },
  timeline: { defaultWidth: 640, defaultHeight: 120 },
}

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

export function isCanvasDocumentEmpty(doc: Y.Doc): boolean {
  return nodesOf(doc).size === 0 && annotationsOf(doc).size === 0
}

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
      const { id, x, y, width, height, ...data } = element
      return { id, type: data.video ? 'video' : 'image', x, y, width, height, z, data }
    }
    case 'text': {
      const { id, x, y, width, height, ...data } = element
      return { id, type: 'text', x, y, width, height, z, data }
    }
    case 'timeline': {
      const { id, x, y, width, height, ...data } = element
      return { id, type: 'timeline', x, y, width, height, z, data }
    }
    case 'placeholder':
    case 'generation': {
      // 运行中或失败的生成在节点画布里是还没有结果的图片节点；原记录整份保留，任务续跑与失败出路照旧认它。
      const { id, x, y, width, height, ...pending } = element
      return { id, type: 'image', x, y, width, height, z, data: { pending } }
    }
  }
}

/**
 * 把旧存档的元素搬进一份空文档。文档已有内容时什么都不做：转换只发生一次，
 * 之后以 `Y.Doc` 为准，旧存档原样留着。
 */
export function importLegacyElements(
  doc: Y.Doc,
  elements: readonly LegacyCanvasElement[],
  origin: CanvasOrigin,
): void {
  if (!isCanvasDocumentEmpty(doc)) return
  doc.transact(() => {
    elements.forEach((element, z) => {
      const item = toNode(element, z)
      if (item.type === 'arrow' || item.type === 'freedraw') {
        annotationsOf(doc).set(item.id, item as CanvasAnnotation)
      } else writeNode(doc, item as CanvasNode)
    })
  }, origin)
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
