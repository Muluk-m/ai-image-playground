import {
  appendScriptEpisode,
  type CanvasNode,
  type CanvasOrigin,
  canvasNodeRegistry,
  connectCanvasNodes,
  insertCanvasNode,
  isCanvasStoryboardData,
  prepareStoryboardFrames,
  readCanvasDocument,
  replaceStoryboardShots,
  type StageStoryboardFinalization,
  StoryboardFlowError,
  type StoryboardFrameMode,
  type StoryboardStageSummary,
  stageNodeRunnable,
  storyboardFingerprint,
  storyboardStageSummary,
  type TextNodeData,
  updateCanvasNode,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { throwCanvasInvalid } from './errors'
import { getCanvasNode, missingNodeMessage } from './node-ops'

export type CanvasGraph = ReturnType<typeof readCanvasDocument>
export type StoryboardCanvasNode = Extract<CanvasNode, { type: 'storyboard' }>
export type StageStoryboardSummaryRef = {
  ref: StageStoryboardFinalization
  summary: StoryboardStageSummary
}

export interface CanvasScriptAssetInput {
  id: string
  kind: 'person' | 'location' | 'prop' | 'product'
  name: string
  description: string
}

export interface CanvasScriptShotInput {
  id: string
  description: string
  dialogue?: string
  camera?: string
  durationSeconds?: number
  lookIds: readonly string[]
  locationId?: string
}

export interface CanvasScriptEpisodeInput {
  number: number
  text: string
}

export interface CanvasScriptPlanInput {
  scriptNodeId: string
  storyboardId: string
  episodeNumber?: number
  assets: readonly CanvasScriptAssetInput[]
  shots: readonly CanvasScriptShotInput[]
  episode?: CanvasScriptEpisodeInput
}

export function canvasStageNodeName(node: CanvasNode): string {
  return 'name' in node.data && node.data.name ? node.data.name : '未命名节点'
}

/** 分镜表流程铺出的首帧与宫格节点。它们只能经首帧阶段出图，确认时才会把分镜表定稿。 */
export function isStoryboardFrameNode(node: CanvasNode): boolean {
  if (node.type !== 'image' && node.type !== 'video') return false
  const meta = node.data.meta
  return Boolean(
    meta?.storyboardId && (meta.storyboardRole === 'frame' || meta.storyboardRole === 'grid'),
  )
}

/** 解析阶段授权范围：校验节点/分组存在、展开分组、拒绝分镜首帧并区分无提示词素材。 */
export function selectRunnableStageNodes(
  graph: CanvasGraph,
  requested: readonly string[],
): CanvasNode[] {
  const existing = new Set([
    ...graph.nodes.map((node) => node.id),
    ...(graph.groups ?? []).map((group) => group.id),
  ])
  for (const id of requested)
    if (!existing.has(id)) throwCanvasInvalid(missingNodeMessage(id, graph.nodes))
  const ids = new Set(requested)
  for (const group of graph.groups ?? [])
    if (ids.has(group.id)) for (const nodeId of group.members) ids.add(nodeId)
  const scoped = graph.nodes.filter((node) => ids.has(node.id))
  const promptlessAssets = scoped.filter(
    (node) =>
      (node.type === 'image' || node.type === 'video') &&
      node.data.meta?.nodeKind === 'asset' &&
      !stageNodeRunnable(node, graph.edges),
  )
  const nodes = scoped.filter((node) => stageNodeRunnable(node, graph.edges))
  const frames = nodes.filter(isStoryboardFrameNode)
  if (frames.length)
    return throwCanvasInvalid(
      `「${frames.map(canvasStageNodeName).join('、')}」是分镜表的首帧，请用 runStoryboardFrames 出首帧：默认宫格，单镜重出传 shotIds。`,
    )
  if (!nodes.length)
    return throwCanvasInvalid(
      promptlessAssets.length
        ? '范围内的素材节点没有提示词，也没有素材描述，不能单独生成。请用 updateNodes 写上提示词，或改为指定图片、视频节点。'
        : '范围内没有可生成的图片或视频节点。',
    )
  return nodes
}

const FRAME_NAMES = {
  frame: (index: number) => `第 ${index} 镜 · 首帧`,
  grid: (index: number) => `首帧宫格 ${index}`,
  video: (index: number) => `第 ${index} 镜 · 视频`,
}

function storyboardFlowMessage(error: unknown): string | undefined {
  if (!(error instanceof StoryboardFlowError)) return undefined
  switch (error.code) {
    case 'finalizeFirst':
      return '分镜表没有镜头，或镜头数超过上限，不能铺首帧。'
    case 'promptTooLong':
      return '有镜头的描述太长，写不进首帧提示词。请先用 applyScriptPlan 精简或拆分这一镜。'
    default:
      return `首帧没有铺出：${error.code}`
  }
}

export function prepareCanvasStoryboardFrames(
  doc: Y.Doc,
  storyboardId: string,
  mode: StoryboardFrameMode,
  origin: CanvasOrigin,
) {
  try {
    return prepareStoryboardFrames(doc, storyboardId, mode, {
      origin,
      names: FRAME_NAMES,
      allowDraft: true,
    })
  } catch (error) {
    const message = storyboardFlowMessage(error)
    if (message) return throwCanvasInvalid(message)
    throw error
  }
}

/**
 * shotIds 里混进了这张分镜表铺出的首帧节点 id 时，换成它对应的镜头 id：模型常把刚铺出的首帧节点
 * 当成镜头传进来。认不出的原样留下，交给后面按未知镜头拒绝。
 */
export function resolveStoryboardShotIds(
  nodes: readonly CanvasNode[],
  board: StoryboardCanvasNode,
  shotIds: readonly string[] | undefined,
): string[] | undefined {
  if (!shotIds) return undefined
  const known = new Set(board.data.shots.map((shot) => shot.id))
  return [
    ...new Set(
      shotIds.map((value) => {
        if (known.has(value)) return value
        const node = nodes.find((one) => one.id === value)
        const meta = node?.type === 'image' || node?.type === 'video' ? node.data.meta : undefined
        return meta?.storyboardId === board.id &&
          meta.storyboardRole === 'frame' &&
          meta.storyboardShotId &&
          known.has(meta.storyboardShotId)
          ? meta.storyboardShotId
          : value
      }),
    ),
  ]
}

export function unknownStoryboardShotsMessage(
  board: StoryboardCanvasNode,
  unknown: readonly string[],
): string {
  const listed = board.data.shots.map((shot, index) => `第 ${index + 1} 镜 ${shot.id}`).join('、')
  return `分镜表里没有这些镜头：${unknown.join('、')}。没有铺首帧，也没有登记授权。shotIds 填分镜表的镜头 id，不是首帧节点或素材节点 id；这张分镜表的镜头是：${listed}。出整张表的首帧时不传 shotIds。请改正参数后在这一轮重新调用。`
}

/**
 * 重放同一次调用时返回首次登记的授权对应的分镜表摘要。
 * 镜头表已经改过（指纹不同）就不附摘要，确认时也会因过时被拒。
 */
export function replayedStoryboardRef(
  doc: Y.Doc,
  ref: StageStoryboardFinalization | undefined,
): StageStoryboardSummaryRef | undefined {
  if (!ref) return undefined
  const board = readCanvasDocument(doc).nodes.find((node) => node.id === ref.storyboardId)
  if (board?.type !== 'storyboard' || storyboardFingerprint(board.data.shots) !== ref.fingerprint)
    return undefined
  return { ref, summary: storyboardStageSummary(board.id, board.data.shots) }
}

// `CanvasNode` 是基类型与联合的交集，直接判 `type` 收不住 `data`，所以从这里返回。
function textData(node: CanvasNode): TextNodeData {
  return node.type === 'text' ? node.data : throwCanvasInvalid('只能拆分文本剧本节点。')
}

export function applyCanvasScriptPlan(
  doc: Y.Doc,
  params: CanvasScriptPlanInput,
  origin: CanvasOrigin,
): void {
  const script = getCanvasNode(doc, params.scriptNodeId)
  const scriptText = textData(script)
  const snapshot = readCanvasDocument(doc)
  const existingBoard = snapshot.nodes.find((node) => node.id === params.storyboardId)
  if (existingBoard && existingBoard.type !== 'storyboard')
    throwCanvasInvalid(`节点不是分镜表：${params.storyboardId}`)
  const boundEpisode = existingBoard?.type === 'storyboard' ? existingBoard.data.episode : undefined
  const episodeNumber = params.episodeNumber ?? params.episode?.number ?? boundEpisode?.number ?? 1
  if (params.episode && params.episode.number !== episodeNumber)
    throwCanvasInvalid('追加的剧本集号必须与分镜表的 episodeNumber 一致。')
  if (
    boundEpisode &&
    (boundEpisode.scriptNodeId !== script.id || boundEpisode.number !== episodeNumber)
  )
    throwCanvasInvalid(
      `分镜表 ${params.storyboardId} 已属于原剧本第 ${boundEpisode.number} 集，请更新该集原表。`,
    )
  const duplicate = snapshot.nodes.find(
    (node) =>
      node.type === 'storyboard' &&
      node.id !== params.storyboardId &&
      (node.data.episode?.number ?? 1) === episodeNumber,
  )
  if (duplicate)
    throwCanvasInvalid(
      `第 ${episodeNumber} 集已有生效分镜表 ${duplicate.id}，请用此 storyboardId 更新原表，不要新建第二张表。`,
    )
  const taken = new Set(snapshot.nodes.map((node) => node.id))
  taken.add(params.storyboardId)
  for (const asset of params.assets) {
    if (taken.has(asset.id)) throwCanvasInvalid(`节点 id 已存在：${asset.id}`)
    taken.add(asset.id)
  }
  const kinds = new Map(params.assets.map((asset) => [asset.id, asset.kind]))
  for (const node of readCanvasDocument(doc).nodes)
    if (node.type === 'image' && node.data.meta?.nodeKind === 'asset' && node.data.meta.assetKind)
      kinds.set(node.id, node.data.meta.assetKind as CanvasScriptAssetInput['kind'])
  for (const shot of params.shots) {
    for (const look of shot.lookIds)
      if (kinds.get(look) !== 'person') throwCanvasInvalid(`人物引用不存在：${look}`)
    if (shot.locationId && kinds.get(shot.locationId) !== 'location')
      throwCanvasInvalid(`地点引用不存在：${shot.locationId}`)
  }
  const shots = params.shots.map((shot) => ({
    id: shot.id,
    description: shot.description,
    ...(shot.dialogue ? { dialogue: shot.dialogue } : {}),
    ...(shot.camera ? { camera: shot.camera } : {}),
    ...(shot.durationSeconds !== undefined ? { durationSeconds: shot.durationSeconds } : {}),
    lookIds: [...shot.lookIds],
    ...(shot.locationId ? { locationId: shot.locationId } : {}),
  }))
  if (!isCanvasStoryboardData({ shots })) throwCanvasInvalid('分镜表不合法。')
  if (params.episode) {
    const next =
      appendScriptEpisode(scriptText.text, params.episode.number, params.episode.text) ??
      throwCanvasInvalid(`第 ${params.episode.number} 集已经在剧本里，或正文是空的。`)
    const { richText: _rich, ...data } = scriptText
    updateCanvasNode(doc, script.id, { data: { ...data, text: next } }, origin)
  }
  const existing = readCanvasDocument(doc).nodes
  const right = Math.max(...existing.map((node) => node.x + node.width)) + 168
  if (!existingBoard) {
    const board = canvasNodeRegistry.storyboard.size
    insertCanvasNode(
      doc,
      {
        id: params.storyboardId,
        type: 'storyboard',
        x: right + canvasNodeRegistry.image.size.width + 168,
        y: script.y,
        width: board.width,
        height: board.height,
        data: { shots: [] },
      },
      origin,
    )
  }
  replaceStoryboardShots(doc, params.storyboardId, shots, origin)
  const updatedBoard = getCanvasNode(doc, params.storyboardId)
  if (updatedBoard.type === 'storyboard')
    updateCanvasNode(
      doc,
      params.storyboardId,
      {
        data: {
          ...updatedBoard.data,
          episode: { scriptNodeId: script.id, number: episodeNumber },
        },
      },
      origin,
    )
  const written = readCanvasDocument(doc).nodes.find((node) => node.id === params.storyboardId)
  if (written?.type !== 'storyboard' || written.data.shots.length !== shots.length)
    throwCanvasInvalid('分镜表没有写入。')
  let nextY = script.y
  for (const asset of params.assets) {
    const size = canvasNodeRegistry.image.size
    insertCanvasNode(
      doc,
      {
        id: asset.id,
        type: 'image',
        x: right,
        y: nextY,
        width: size.width,
        height: size.height,
        data: {
          name: asset.name,
          meta: {
            nodeKind: 'asset',
            assetKind: asset.kind,
            assetDescription: asset.description,
          },
        },
      },
      origin,
    )
    if (!connectCanvasNodes(doc, { source: asset.id, target: params.storyboardId }, origin))
      throwCanvasInvalid(`素材无法连接到分镜表：${asset.id}`)
    nextY += size.height + 48
  }
  if (
    !readCanvasDocument(doc).edges.some(
      (edge) => edge.source === script.id && edge.target === params.storyboardId,
    ) &&
    !connectCanvasNodes(doc, { source: script.id, target: params.storyboardId }, origin)
  )
    throwCanvasInvalid('剧本无法连接到分镜表。')
}
