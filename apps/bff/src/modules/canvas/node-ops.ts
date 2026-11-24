import {
  type CanvasNode,
  type CanvasOrigin,
  canvasInputFingerprint,
  canvasMainResult,
  canvasNodeKind,
  canvasNodeRegistry,
  canvasNodeSourceData,
  chooseCanvasResult,
  connectCanvasNodes,
  deleteCanvasNode,
  insertCanvasNode,
  layoutCanvasArrange,
  moveCanvasNodes,
  readCanvasDocument,
  recordCanvasResult,
  ungroupCanvasNodes,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { throwCanvasInvalid } from './errors'

export type CanvasVideoMode = 'text' | 'first' | 'frames' | 'reference'

export interface CanvasNodePatchFields {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  name?: string
  text?: string
  prompt?: string
  videoMode?: CanvasVideoMode
}

export interface CanvasNodeCreateInput extends CanvasNodePatchFields {
  type: 'text' | 'image' | 'video' | 'timeline' | 'storyboard'
  imageId?: string
}

export interface CanvasNodeImageSource {
  mediaId: string
  name?: string
}

export type CanvasVideoModeCheck = (mode: string, meta: Readonly<Record<string, string>>) => void

export function getCanvasNode(doc: Y.Doc, id: string): CanvasNode {
  const nodes = readCanvasDocument(doc).nodes
  return nodes.find((node) => node.id === id) ?? throwCanvasInvalid(missingNodeMessage(id, nodes))
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    previous = current
  }
  return previous[b.length]!
}

/**
 * 报错时给出最接近的现有节点。只说“不存在”时模型会凭记忆再抄一遍同样的错 ID
 * （2026-10-18 会话 d61eb8fc 连续 16 次）。
 */
export function missingNodeMessage(id: string, nodes: readonly CanvasNode[]): string {
  const nearest = nodes
    .map((node) => ({ node, distance: editDistance(id, node.id) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map(({ node }) => {
      const name = 'name' in node.data && node.data.name ? `（${node.data.name}）` : ''
      return `${node.id}${name}`
    })
  return nearest.length
    ? `节点不存在：${id}。最接近的现有节点：${nearest.join('、')}。请照抄 readCanvas 返回的 ID。`
    : `节点不存在：${id}。当前画布没有节点。`
}

export function patchCanvasNode(
  doc: Y.Doc,
  fields: CanvasNodePatchFields,
  origin: CanvasOrigin,
  checkVideoMode?: CanvasVideoModeCheck,
): void {
  const node = getCanvasNode(doc, fields.id)
  const kind = canvasNodeKind(node)
  if (fields.videoMode && kind !== 'video') throwCanvasInvalid('只有视频节点可以设置 videoMode。')
  if (fields.videoMode && checkVideoMode && (node.type === 'image' || node.type === 'video'))
    checkVideoMode(fields.videoMode, node.data.meta ?? {})
  if (
    kind === 'video' &&
    (fields.prompt !== undefined || fields.videoMode !== undefined) &&
    !fields.videoMode
  )
    throwCanvasInvalid('修改视频提示词时必须显式指定 videoMode。')
  if (fields.text !== undefined && kind !== 'text')
    throwCanvasInvalid('只有文本节点可以设置 text。')
  if (fields.prompt !== undefined && kind !== 'image' && kind !== 'video')
    throwCanvasInvalid('只有图片和视频节点可以设置 prompt。')
  const changesData =
    fields.name !== undefined ||
    fields.text !== undefined ||
    fields.prompt !== undefined ||
    fields.videoMode !== undefined
  let data: CanvasNode['data'] | undefined
  const source = canvasNodeSourceData(doc, node.id)!
  if (changesData && node.type === 'text')
    data = {
      ...node.data,
      ...(fields.text !== undefined ? { text: fields.text, richText: undefined } : {}),
      ...(fields.name !== undefined ? { name: fields.name } : {}),
    }
  else if (changesData && (node.type === 'image' || node.type === 'video'))
    data = {
      ...source,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      meta: {
        ...('meta' in source ? source.meta : {}),
        ...(fields.prompt !== undefined ? { nodePrompt: fields.prompt } : {}),
        ...(fields.videoMode ? { nodeVideoMode: fields.videoMode } : {}),
      },
    }
  else if (changesData && fields.name !== undefined)
    throwCanvasInvalid('时间线和分镜表不支持此名称字段。')
  updateCanvasNode(
    doc,
    fields.id,
    {
      ...(fields.x !== undefined ? { x: fields.x } : {}),
      ...(fields.y !== undefined ? { y: fields.y } : {}),
      ...(fields.width !== undefined ? { width: fields.width } : {}),
      ...(fields.height !== undefined ? { height: fields.height } : {}),
      ...(data ? { data } : {}),
    },
    origin,
  )
}

export function insertCanvasNodes(
  doc: Y.Doc,
  nodes: readonly CanvasNodeCreateInput[],
  sources: ReadonlyMap<string, CanvasNodeImageSource>,
  origin: CanvasOrigin,
  checkVideoMode?: CanvasVideoModeCheck,
): void {
  const existing = readCanvasDocument(doc).nodes
  const right = existing.length ? Math.max(...existing.map((node) => node.x + node.width)) + 168 : 0
  let nextY = 0
  for (const node of nodes) {
    if (readCanvasDocument(doc).nodes.some((one) => one.id === node.id))
      throwCanvasInvalid(`节点 id 已存在：${node.id}`)
    if (node.type === 'video' && !node.videoMode)
      throwCanvasInvalid('创建视频节点必须显式指定 videoMode。')
    insertCanvasNode(
      doc,
      {
        id: node.id,
        type: node.type === 'video' ? 'image' : node.type,
        x: node.x ?? right,
        y: node.y ?? nextY,
        width: node.width ?? canvasNodeRegistry[node.type].size.width,
        height: node.height ?? canvasNodeRegistry[node.type].size.height,
        data:
          node.type === 'text'
            ? { text: '', fontSize: 16, fill: '#fff' }
            : node.type === 'timeline'
              ? { clips: [] }
              : node.type === 'storyboard'
                ? { shots: [] }
                : { ...sources.get(node.id), meta: { nodeKind: node.type } },
      },
      origin,
    )
    patchCanvasNode(doc, node, origin, checkVideoMode)
    nextY = (node.y ?? nextY) + (node.height ?? canvasNodeRegistry[node.type].size.height) + 168
  }
}

export function importImageIntoAssetNode(
  doc: Y.Doc,
  params: { imageNodeId: string; assetNodeId: string; viewLabel?: 'sheet' },
  origin: CanvasOrigin,
): void {
  const source = getCanvasNode(doc, params.imageNodeId)
  const target = getCanvasNode(doc, params.assetNodeId)
  if (target.type !== 'image' || target.data.meta?.nodeKind !== 'asset')
    return throwCanvasInvalid('目标必须是素材节点。')
  if (source.id === target.id) throwCanvasInvalid('来源图片与目标素材节点不能相同。')
  if (source.type !== 'image' || canvasNodeKind(source) !== 'image' || !source.data.mediaId)
    return throwCanvasInvalid(
      '来源节点尚无已同步的真实图片；请等待生成或上传完成，不能声称已挂图。',
    )
  const mediaId = source.data.mediaId
  if (!canvasMainResult(doc, target.id) && target.data.mediaId) {
    recordCanvasResult(
      doc,
      {
        id: `import:${crypto.randomUUID()}`,
        nodeId: target.id,
        kind: 'image',
        source: { type: 'media', mediaId: target.data.mediaId },
        createdAt: Date.now() - 1,
        adopted: true,
        display: {
          mediaId: target.data.mediaId,
          ...(target.data.naturalWidth ? { naturalWidth: target.data.naturalWidth } : {}),
          ...(target.data.naturalHeight ? { naturalHeight: target.data.naturalHeight } : {}),
        },
      },
      origin,
    )
  }
  const resultId = `import:${crypto.randomUUID()}`
  recordCanvasResult(
    doc,
    {
      id: resultId,
      nodeId: target.id,
      kind: 'image',
      source: { type: 'media', mediaId },
      createdAt: Date.now(),
      inputFingerprint: canvasInputFingerprint(doc, target.id),
      ...(params.viewLabel ? { assetViewLabel: params.viewLabel } : {}),
    },
    origin,
  )
  if (
    !chooseCanvasResult(
      doc,
      target.id,
      resultId,
      {
        data: {
          mediaId,
          naturalWidth: source.data.naturalWidth,
          naturalHeight: source.data.naturalHeight,
        },
      },
      origin,
    )
  )
    throwCanvasInvalid('图片未能收进素材，请重新读取画布。')
}

export function connectCanvasNodeEdges(
  doc: Y.Doc,
  edges: readonly { source: string; target: string }[],
  origin: CanvasOrigin,
): void {
  for (const edge of edges) {
    if (
      readCanvasDocument(doc).edges.some(
        (existing) => existing.source === edge.source && existing.target === edge.target,
      )
    )
      continue
    if (!connectCanvasNodes(doc, edge, origin))
      throwCanvasInvalid(`不支持的节点关联：${edge.source} → ${edge.target}`)
  }
}

export function deleteCanvasNodes(
  doc: Y.Doc,
  nodeIds: readonly string[],
  origin: CanvasOrigin,
): void {
  for (const id of nodeIds) getCanvasNode(doc, id)
  ungroupCanvasNodes(doc, nodeIds, origin)
  for (const id of nodeIds) deleteCanvasNode(doc, id, origin)
}

export function arrangeCanvasNodes(
  doc: Y.Doc,
  nodeIds: readonly string[],
  columns: number | undefined,
  origin: CanvasOrigin,
): void {
  for (const id of nodeIds) getCanvasNode(doc, id)
  const placements = layoutCanvasArrange(
    [{ columns, items: nodeIds.map((elementId) => ({ elementId })) }],
    readCanvasDocument(doc).nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      w: node.width,
      h: node.height,
    })),
  )
  moveCanvasNodes(
    doc,
    placements.map((item) => ({ id: item.elementId, x: item.x, y: item.y })),
    origin,
  )
}
