import {
  appendScriptEpisode,
  type CanvasNode,
  type CanvasOrigin,
  canvasInputFingerprint,
  canvasMainResult,
  canvasNodeKind,
  canvasNodeRegistry,
  canvasNodeSourceData,
  canvasStageRunsDirectly,
  chooseCanvasResult,
  connectCanvasNodes,
  deleteCanvasNode,
  insertCanvasNode,
  isCanvasStoryboardData,
  layoutCanvasArrange,
  moveCanvasNodes,
  parseCompleteStageVideoDraft,
  prepareStoryboardFrames,
  readCanvasDocument,
  recordCanvasResult,
  replaceStoryboardShots,
  resolveStageImageExecution,
  resolveStageVideoExecution,
  type StageAuthorization,
  type StageAuthorizationTurn,
  type StageExecutionBinding,
  type StageStoryboardFinalization,
  StoryboardFlowError,
  type StoryboardFrameMode,
  type StoryboardStageSummary,
  stageExecutionBinding,
  stageNodeRunnable,
  storyboardFingerprint,
  storyboardMissingAssetNodes,
  storyboardStageSummary,
  type TextNodeData,
  ungroupCanvasNodes,
  updateCanvasNode,
  videoModelSupportOf,
} from '@image-playground/shared'
import { type Static, Type } from 'typebox'
import * as Y from 'yjs'
import { executeCanvasCommand } from '../../canvasCommands'
import { accessCanvasDocument } from '../../canvasSyncStore'
import { isCapabilityEnabled } from '../../capabilities'
import type { BffTransaction } from '../../private-overlay'
import { agentCanvasProject } from '../node-canvas-view'
import {
  proposeStageAuthorization,
  proposeStageAuthorizationInTransaction,
  readStageAuthorization,
  readStageProposal,
  StageAuthorizationError,
  type StageChargeInput,
  type StageProposalInput,
} from '../stage-authorizations'
import { agentVideoModel, agentVideoModels } from '../video-models'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { resolveAgentModel } from './queueTask'
import type { AgentToolAudience, AgentToolContext } from './types'

const id = Type.String({ minLength: 1, maxLength: 128 })
const videoMode = Type.Union([
  Type.Literal('text'),
  Type.Literal('first'),
  Type.Literal('frames'),
  Type.Literal('reference'),
])
const fields = {
  x: Type.Optional(Type.Number({ minimum: -1000000, maximum: 1000000 })),
  y: Type.Optional(Type.Number({ minimum: -1000000, maximum: 1000000 })),
  width: Type.Optional(Type.Number({ minimum: 40, maximum: 5000 })),
  height: Type.Optional(Type.Number({ minimum: 40, maximum: 5000 })),
  name: Type.Optional(
    Type.String({
      maxLength: 120,
      description: '仅 text、image、video 节点可设名称；timeline 与 storyboard 节点不要传 name。',
    }),
  ),
  text: Type.Optional(Type.String({ maxLength: 100000 })),
  prompt: Type.Optional(Type.String({ maxLength: 100000 })),
  videoMode: Type.Optional(videoMode),
}
const createParameters = Type.Object({
  nodes: Type.Array(
    Type.Object({
      id,
      type: Type.Union([
        Type.Literal('text'),
        Type.Literal('image'),
        Type.Literal('video'),
        Type.Literal('timeline'),
        Type.Literal('storyboard'),
      ]),
      ...fields,
      imageId: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description:
            '仅 image 节点：用对话里已有图片的 ID（本轮附图或会话图片）建成素材节点，节点直接显示这张图，可作为参考连给生成节点。',
        }),
      ),
    }),
    { minItems: 1, maxItems: 100 },
  ),
})
const updateParameters = Type.Object({
  nodes: Type.Array(Type.Object({ id, ...fields }), { minItems: 1, maxItems: 100 }),
})
type NodeFields = Static<typeof updateParameters>['nodes'][number]
const modes = ['image', 'video'] as const
const available = (_mode: unknown, audience?: AgentToolAudience) =>
  Boolean(
    audience?.userId && audience.experience === 'canvas' && isCapabilityEnabled('accounts:sync'),
  )
const guidance =
  '分镜表的首帧不要用这些工具手工搭，用 runStoryboardFrames。修改前用 readCanvas 读取需要的节点。一次调用会原子保存并可整体撤销，不运行生成、不计费。视频节点必须明确给出 videoMode，不能依引用数量推断。用户在对话里附的图要接进节点时，用 createNodes 的 imageId 建素材节点再 connectNodes，不要让用户自己把图拖进画布或选中节点。'
const invalid = (message: string): never => {
  throw new AgentToolError('invalid_params', message)
}
function getNode(doc: Y.Doc, id: string) {
  const nodes = readCanvasDocument(doc).nodes
  return nodes.find((node) => node.id === id) ?? invalid(missingNodeMessage(id, nodes))
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
// `CanvasNode` 是基类型与联合的交集，直接判 `type` 收不住 `data`，所以从这里返回。
function textData(node: CanvasNode): TextNodeData {
  return node.type === 'text' ? node.data : invalid('只能拆分文本剧本节点。')
}
export function patchAgentCanvasNode(doc: Y.Doc, fields: NodeFields, origin: CanvasOrigin) {
  const node = getNode(doc, fields.id)
  const kind = canvasNodeKind(node)
  if (fields.videoMode && kind !== 'video') invalid('只有视频节点可以设置 videoMode。')
  if (
    kind === 'video' &&
    (fields.prompt !== undefined || fields.videoMode !== undefined) &&
    !fields.videoMode
  )
    invalid('修改视频提示词时必须显式指定 videoMode。')
  if (fields.text !== undefined && kind !== 'text') invalid('只有文本节点可以设置 text。')
  if (fields.prompt !== undefined && kind !== 'image' && kind !== 'video')
    invalid('只有图片和视频节点可以设置 prompt。')
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
  else if (changesData && fields.name !== undefined) invalid('时间线和分镜表不支持此名称字段。')
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
async function write(
  context: AgentToolContext,
  toolCallId: string,
  label: string,
  args: unknown,
  mutate: (doc: Y.Doc, origin: CanvasOrigin) => void,
) {
  if (!available(context.mode, context)) invalid('当前会话没有可写的云端节点画布。')
  const project = await agentCanvasProject(context)
  if (!project || !context.userId) return invalid('当前会话没有已同步的云端项目。')
  await context.assertExecution?.()
  const result = await executeCanvasCommand(
    context.userId,
    project.id,
    { turnId: context.turnId, toolCallId, label, args },
    mutate,
  )
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ...result,
          saved: true,
          note: '已保存到服务端画布，可撤销；没有启动生成任务。',
        }),
      },
    ],
    details: {},
  }
}

export const createNodes = defineAgentTool({
  name: 'createNodes',
  label: '创建节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '在当前云端画布批量创建节点。id 必须是新的唯一节点标识；不填位置时排列到已有内容右侧。视频必须显式选择 videoMode: text文生、first首帧、frames首尾帧、reference参考生。不会生成媒体。',
  parameters: createParameters,
  call: () => ({ title: '创建节点' }),
  execute: (context) => async (callId, params) => {
    const sources = await nodeImageSources(context, params.nodes)
    return write(context, callId, '创建节点', params, (doc, origin) => {
      const existing = readCanvasDocument(doc).nodes
      const right = existing.length
        ? Math.max(...existing.map((node) => node.x + node.width)) + 168
        : 0
      let nextY = 0
      for (const node of params.nodes) {
        if (readCanvasDocument(doc).nodes.some((existing) => existing.id === node.id))
          invalid(`节点 id 已存在：${node.id}`)
        if (node.type === 'video' && !node.videoMode)
          invalid('创建视频节点必须显式指定 videoMode。')
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
        patchAgentCanvasNode(doc, node, origin)
        nextY = (node.y ?? nextY) + (node.height ?? canvasNodeRegistry[node.type].size.height) + 168
      }
    })
  },
})

/**
 * 对话里的图要接进节点画布，只能先落成带云媒体的素材节点。没有这一步时模型只能请用户把附图拖进画布
 * 再选中（2026-10-19 会话 e71a6e9e 连续四轮卡在这里）。
 */
async function nodeImageSources(
  context: AgentToolContext,
  nodes: Static<typeof createParameters>['nodes'],
): Promise<Map<string, { mediaId: string; name?: string }>> {
  const wanted = nodes.filter((node) => node.imageId)
  for (const node of wanted)
    if (node.type !== 'image') invalid(`只有 image 节点可以设置 imageId：${node.id}`)
  if (!wanted.length) return new Map()
  const resolved = await context.images.resolveMediaReferences(wanted.map((node) => node.imageId!))
  const sources = new Map<string, { mediaId: string; name?: string }>()
  for (const [index, node] of wanted.entries()) {
    const reference = resolved[index]
    if (!reference) {
      const available = context.images.references.map((one) => one.imageId).join('、')
      invalid(
        `找不到可用作素材的图片：${node.imageId}。${available ? `本轮可用的图片 ID：${available}。` : '请让用户重新上传这张图。'}`,
      )
    }
    sources.set(node.id, {
      mediaId: reference!.mediaId,
      ...(reference!.name ? { name: reference!.name } : {}),
    })
  }
  return sources
}
export const updateNodes = defineAgentTool({
  name: 'updateNodes',
  label: '修改节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '批量修改已有节点的位置、尺寸、名称、文本或生成提示词。只更新显式传入字段，不替换整份画布；视频提示词变更必须提供 videoMode。',
  parameters: updateParameters,
  call: () => ({ title: '修改节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '修改节点', params, (doc, origin) => {
      for (const node of params.nodes) patchAgentCanvasNode(doc, node, origin)
    }),
})

export const importCanvasImage = defineAgentTool({
  name: 'importCanvasImage',
  label: '收图进素材',
  modes,
  available,
  onError: 'continue',
  guidance:
    '用户指定画布上的已有图片作为素材时，先 readCanvas 确认来源图片节点和目标素材节点，再调用本工具；不要重新生成或只改提示词后声称已挂图。只有本工具成功保存后才能说已收进素材。',
  description:
    '把当前画布指定图片节点的真实主图收进指定素材节点，新增一个视角候选并成为主结果。保留来源节点、目标名称和已有候选；原子保存、可撤销，不提交生成任务、不产生生成费用。尚无真实图片的来源会被拒绝。',
  parameters: Type.Object({
    imageNodeId: id,
    assetNodeId: id,
    viewLabel: Type.Optional(Type.Literal('sheet')),
  }),
  call: () => ({ title: '收图进素材' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '收图进素材', params, (doc, origin) => {
      const source = getNode(doc, params.imageNodeId)
      const target = getNode(doc, params.assetNodeId)
      if (target.type !== 'image' || target.data.meta?.nodeKind !== 'asset')
        return invalid('目标必须是素材节点。')
      if (source.id === target.id) invalid('来源图片与目标素材节点不能相同。')
      if (source.type !== 'image' || canvasNodeKind(source) !== 'image' || !source.data.mediaId)
        return invalid('来源节点尚无已同步的真实图片；请等待生成或上传完成，不能声称已挂图。')
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
        invalid('图片未能收进素材，请重新读取画布。')
    }),
})
export const connectNodes = defineAgentTool({
  name: 'connectNodes',
  label: '关联节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '建立 source 到 target 的有向参考关系。按节点类型校验，不依左右位置限制。任一连线不合法时整批不保存；已有连线保持不变。',
  parameters: Type.Object({
    edges: Type.Array(Type.Object({ source: id, target: id }), { minItems: 1, maxItems: 200 }),
  }),
  call: () => ({ title: '关联节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '关联节点', params, (doc, origin) => {
      for (const edge of params.edges) {
        if (
          readCanvasDocument(doc).edges.some(
            (existing) => existing.source === edge.source && existing.target === edge.target,
          )
        )
          continue
        if (!connectCanvasNodes(doc, edge, origin))
          invalid(`不支持的节点关联：${edge.source} → ${edge.target}`)
      }
    }),
})
export const deleteNodes = defineAgentTool({
  name: 'deleteNodes',
  label: '删除节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description: '删除指定节点及其连线、分组成员关系，整批可撤销。不会删除原始素材文件。',
  parameters: Type.Object({
    nodeIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
  }),
  call: () => ({ title: '删除节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '删除节点', params, (doc, origin) => {
      for (const id of params.nodeIds) getNode(doc, id)
      ungroupCanvasNodes(doc, params.nodeIds, origin)
      for (const id of params.nodeIds) deleteCanvasNode(doc, id, origin)
    }),
})
export const arrangeNodes = defineAgentTool({
  name: 'arrangeNodes',
  label: '整理节点',
  modes,
  available,
  guidance,
  onError: 'continue',
  description:
    '把指定节点按阅读顺序整理成网格，避开未选择的节点。只改变位置，不改正文、类型或引用。',
  parameters: Type.Object({
    nodeIds: Type.Array(id, { minItems: 1, maxItems: 200, uniqueItems: true }),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  }),
  call: () => ({ title: '整理节点' }),
  execute: (context) => async (callId, params) =>
    write(context, callId, '整理节点', params, (doc, origin) => {
      for (const id of params.nodeIds) getNode(doc, id)
      const placements = layoutCanvasArrange(
        [{ columns: params.columns, items: params.nodeIds.map((elementId) => ({ elementId })) }],
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
    }),
})

function stageNodeName(node: CanvasNode): string {
  return 'name' in node.data && node.data.name ? node.data.name : '未命名节点'
}
function stageExecution(
  node: CanvasNode,
  params:
    | {
        model?: string
        canvasImageModel?: string
        canvasImageCount?: number
        n?: number
        video?: {
          model: string
          durationSeconds: number
          resolution: string
          aspectRatio?: string
          voiceIds?: readonly string[]
        }
      }
    | undefined,
  graph: { nodes: readonly CanvasNode[]; edges: readonly { source: string; target: string }[] },
  authorizedIds: ReadonlySet<string>,
): { charge?: StageChargeInput; binding: StageExecutionBinding } | undefined {
  if (node.type !== 'image' && node.type !== 'video') return undefined
  const meta = node.data.meta ?? {}
  const videoKind = canvasNodeKind(node) === 'video'
  const workbench = params?.video
    ? {
        model: params.video.model,
        duration: params.video.durationSeconds,
        resolution: params.video.resolution,
        aspectRatio: params.video.aspectRatio ?? '16:9',
        ...(params.video.voiceIds?.length ? { voices: [...params.video.voiceIds] } : {}),
      }
    : undefined
  const globalDraft = videoKind
    ? (workbench ?? parseCompleteStageVideoDraft(meta.nodeVideoDraft))
    : undefined
  const channels = agentVideoModels().map((option) => ({
    modelId: option.target.model,
    support: option.support,
  }))
  const hinted = workbench?.model ?? parseCompleteStageVideoDraft(meta.nodeVideoDraft)?.model
  const builtin = hinted ? videoModelSupportOf(hinted) : undefined
  const resolved =
    globalDraft &&
    resolveStageVideoExecution({
      meta,
      references: graph.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => ({ id: edge.source })),
      globalDraft,
      options: channels.length
        ? channels
        : hinted && builtin
          ? [{ modelId: hinted, support: builtin }]
          : [],
    })
  const binding = stageExecutionBinding({
    node,
    nodes: graph.nodes,
    edges: graph.edges,
    authorizedIds,
    ...(resolved
      ? {
          video: {
            mode: resolved.mode,
            draft: resolved.draft,
            ...(resolved.legacyFirst ? { legacyFirst: resolved.legacyFirst } : {}),
            ...(resolved.legacyLast ? { legacyLast: resolved.legacyLast } : {}),
          },
        }
      : {}),
  })
  if (videoKind) {
    if (
      !resolved ||
      !resolved.spec.model ||
      !Number.isSafeInteger(resolved.spec.quantity) ||
      resolved.spec.quantity < 1
    )
      return { binding }
    return { charge: { nodeId: node.id, ...resolved.spec }, binding }
  }
  // 原标签页按工作台配置出图。报价必须用这一条，不能改成对话模型或渠道里的另一条。
  const image = resolveStageImageExecution({
    model: params?.canvasImageModel?.trim() || resolveAgentModel('image', params?.model)?.model,
    count: params?.canvasImageCount ?? params?.n,
    storyboardRole: meta.storyboardRole,
  })
  return { ...(image ? { charge: { nodeId: node.id, ...image } } : {}), binding }
}
type CanvasGraph = ReturnType<typeof readCanvasDocument>
type StageStoryboard = { ref: StageStoryboardFinalization; summary: StoryboardStageSummary }
/** 按节点规格冻结报价与执行快照。只读画布，不写库。 */
function quoteCanvasStage(
  context: AgentToolContext,
  graph: CanvasGraph,
  nodes: readonly CanvasNode[],
) {
  const billing = isCapabilityEnabled('billing:credits')
  const charges: StageChargeInput[] = []
  const bindings: StageExecutionBinding[] = []
  const authorizedIds = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    const quoted = stageExecution(node, context.params, graph, authorizedIds)
    if (!quoted) return invalid(`无法为节点「${stageNodeName(node)}」建立执行快照。`)
    bindings.push(quoted.binding)
    if (!quoted.charge) {
      if (billing)
        return invalid(
          `无法为节点「${stageNodeName(node)}」计价，授权没有创建。图片需要可用的出图模型；视频需要节点上的模型与时长，或本轮视频参数。`,
        )
      charges.push({ nodeId: node.id, model: '', quantity: 1, unitMultiplier: 1 })
      continue
    }
    charges.push(quoted.charge)
  }
  return { charges, bindings }
}
function stageProposalInput(
  context: AgentToolContext,
  callId: string,
  projectId: string,
  graph: CanvasGraph,
  nodes: readonly CanvasNode[],
  stage: string,
  storyboard?: StageStoryboard,
): StageProposalInput {
  const { charges, bindings } = quoteCanvasStage(context, graph, nodes)
  return {
    userId: context.userId ?? invalid('当前会话没有已同步的云端项目。'),
    conversationId: context.conversationId,
    projectId,
    proposalKey: `${context.turnId}:${callId}`,
    stage,
    nodeIds: nodes.map((node) => node.id),
    nodeNames: nodes.map((node) => stageNodeName(node)),
    nodes: charges,
    bindings,
    ...(storyboard ? { storyboard: storyboard.ref } : {}),
    turn: stageTurn(context.params),
  }
}
/** 记在授权上的本轮出图参数：运行回报唤醒的那一轮照它报价、照它决定是否直接开跑。 */
function stageTurn(params: AgentToolContext['params']): StageAuthorizationTurn {
  const model = params?.model?.trim()
  const canvasImageModel = params?.canvasImageModel?.trim()
  const canvasImageCount = params?.canvasImageCount ?? params?.n
  return {
    autoSubmit: canvasStageRunsDirectly(params),
    ...(model ? { model } : {}),
    ...(canvasImageModel ? { canvasImageModel } : {}),
    ...(canvasImageCount !== undefined ? { canvasImageCount } : {}),
    ...(params?.video ? { video: params.video } : {}),
  }
}
/** 计价不可用时给模型一句能照做的话，其他错误照常抛出。 */
async function proposing<T>(propose: () => Promise<T>): Promise<T> {
  try {
    return await propose()
  } catch (error) {
    if (
      error instanceof StageAuthorizationError &&
      error.code === 'stage_authorization_price_unavailable'
    )
      return invalid('无法为这些节点计价，授权没有创建。请确认模型可用后再提案。')
    throw error
  }
}
const STAGE_NOTE = {
  direct:
    '直接出图：阶段授权已登记，原标签页会立即开跑，没有确认卡，也不等待撤销。不要说待确认。只有 taskIds 中的任务已提交。不得声称已生成。',
  pending:
    '阶段授权待确认；用户确认前不会提交或扣费。确认后只由原标签页运行，实际提交与花费应查询授权状态。不得声称已生成。',
  storyboardDirect: '原标签页开跑前确认这条授权，分镜表随之定稿。',
  storyboardPending: '用户确认这条授权时分镜表随之定稿。',
  storyboardStale:
    '这条首帧阶段授权登记之后分镜表的镜头又改过，它已过时，确认会被拒绝，不会提交或扣费。不要请用户确认它；向用户说明镜头表改过，需要按新镜头表重新发起首帧阶段。',
}
function canvasStageNote(direct: boolean, storyboard: boolean): string {
  const base = direct ? STAGE_NOTE.direct : STAGE_NOTE.pending
  if (!storyboard) return base
  return `${base} ${direct ? STAGE_NOTE.storyboardDirect : STAGE_NOTE.storyboardPending}`
}
/** runNodes 与首帧阶段共用的回执。直接出图偏好只看本轮请求。 */
function canvasStageResult(
  context: AgentToolContext,
  projectId: string,
  authorization: StageAuthorization,
  storyboard?: StageStoryboard,
) {
  const direct = canvasStageRunsDirectly(context.params)
  const canvasRun = {
    projectId,
    nodeIds: authorization.nodeIds,
    nodeNames: authorization.nodeNames,
    authorizationId: authorization.id,
    stage: authorization.stage,
    estimatedCredits: authorization.estimatedCredits,
    budgetCap: authorization.budgetCap,
    status: authorization.status,
    specs: authorization.charges?.map(({ nodeId, model, quantity, unitMultiplier }) => ({
      nodeId,
      model,
      quantity,
      unitMultiplier,
    })),
    direct,
    ...(storyboard ? { storyboard: storyboard.summary } : {}),
  }
  // 首帧阶段重放时镜头表已改过：仍交回原授权，但它待确认时确认必被拒绝，要明说需要重新提案。
  const stale = Boolean(
    authorization.storyboard && !storyboard && authorization.status === 'pending',
  )
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ...canvasRun,
          submitted: false,
          ...(stale ? { storyboardStale: true } : {}),
          note: stale ? STAGE_NOTE.storyboardStale : canvasStageNote(direct, Boolean(storyboard)),
        }),
      },
    ],
    details: { canvasRun },
  }
}
export const runNodes = defineAgentTool({
  name: 'runNodes',
  label: '阶段授权',
  modes,
  available,
  onError: 'continue',
  guidance:
    '为画布节点生成图片或视频都用 runNodes。先 readCanvas 确认节点名称与范围。是否立即开跑由这一轮请求里的用户直接出图偏好决定，工具参数改不了。回执会写明是待确认还是已交给原标签页开跑。只有查到 taskIds 才能说已提交，有真实结果才能说已完成。画布不使用出图模式每轮自动提交额度。',
  description:
    '为当前云端画布的一组可生成图片或视频节点登记持久化阶段授权。预算由服务端按节点模型、数量和倍率计算，estimatedCredits 不决定上限。有提示词的素材按普通出图授权；没写提示词但有素材描述的图片素材按「素材名：描述」出图；两者都没有的素材不会单独授权。直接出图时原标签页立即开跑；用户关掉直接出图时才等确认卡。提供 authorizationId 时只查询真实授权状态、已用额度与任务记录，不重新提交。范围外或预算不足必须重新提案。',
  parameters: Type.Object({
    nodeIds: Type.Optional(Type.Array(id, { minItems: 1, maxItems: 200, uniqueItems: true })),
    stage: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    estimatedCredits: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000000 })),
    authorizationId: Type.Optional(id),
  }),
  call: () => ({ title: '阶段授权' }),
  execute: (context) => async (callId, params) => {
    if (!available(context.mode, context)) invalid('当前会话没有可用的云端节点画布。')
    const project = await agentCanvasProject(context)
    if (!project || !context.userId) return invalid('当前会话没有已同步的云端项目。')
    if (params.authorizationId) {
      const authorization = await readStageAuthorization(context.userId, params.authorizationId)
      if (
        authorization.projectId !== project.id ||
        authorization.conversationId !== context.conversationId
      )
        return invalid('授权不属于当前会话与项目。')
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...authorization,
              submitted: authorization.attempts.some((attempt) => attempt.taskIds.length > 0),
              note:
                authorization.status === 'pending'
                  ? '待确认，尚未提交。'
                  : '只有 taskIds 中的任务已提交；不代表已完成。',
            }),
          },
        ],
        details: {},
      }
    }
    await context.assertExecution?.()
    const requested = params.nodeIds
    if (!requested?.length) return invalid('需要指定要生成的节点。')
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, await accessCanvasDocument(context.userId, project.id))
      const graph = readCanvasDocument(doc)
      const existing = new Set([
        ...graph.nodes.map((node) => node.id),
        ...(graph.groups ?? []).map((group) => group.id),
      ])
      for (const id of requested)
        if (!existing.has(id)) invalid(missingNodeMessage(id, graph.nodes))
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
      const frames = nodes.filter(storyboardFrameNode)
      if (frames.length)
        return invalid(
          `「${frames.map(stageNodeName).join('、')}」是分镜表的首帧，请用 runStoryboardFrames 出首帧：默认宫格，单镜重出传 shotIds。`,
        )
      if (!nodes.length)
        return invalid(
          promptlessAssets.length
            ? '范围内的素材节点没有提示词，也没有素材描述，不能单独生成。请用 updateNodes 写上提示词，或改为指定图片、视频节点。'
            : '范围内没有可生成的图片或视频节点。',
        )
      const input = stageProposalInput(
        context,
        callId,
        project.id,
        graph,
        nodes,
        params.stage ?? '节点生成',
      )
      const authorization = await proposing(() => proposeStageAuthorization(input))
      return canvasStageResult(context, project.id, authorization)
    } finally {
      doc.destroy()
    }
  },
})

/** 分镜表流程铺出的首帧与宫格节点。它们只能经首帧阶段出图，确认时才会把分镜表定稿。 */
function storyboardFrameNode(node: CanvasNode): boolean {
  if (node.type !== 'image' && node.type !== 'video') return false
  const meta = node.data.meta
  return Boolean(
    meta?.storyboardId && (meta.storyboardRole === 'frame' || meta.storyboardRole === 'grid'),
  )
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
      return `分镜表没有镜头，或镜头数超过上限，不能铺首帧。`
    case 'promptTooLong':
      return '有镜头的描述太长，写不进首帧提示词。请先用 applyScriptPlan 精简或拆分这一镜。'
    default:
      return `首帧没有铺出：${error.code}`
  }
}
function prepareFrames(
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
    if (message) return invalid(message)
    throw error
  }
}
const scratchOrigin: CanvasOrigin = 'agent:storyboard-frames'
type StoryboardCanvasNode = Extract<CanvasNode, { type: 'storyboard' }>
/**
 * shotIds 里混进了这张分镜表铺出的首帧节点 id 时，换成它对应的镜头 id：模型常把刚铺出的首帧节点
 * 当成镜头传进来。认不出的原样留下，交给后面按未知镜头拒绝。
 */
function storyboardShotIds(
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
function unknownShotsMessage(board: StoryboardCanvasNode, unknown: readonly string[]): string {
  const listed = board.data.shots.map((shot, index) => `第 ${index + 1} 镜 ${shot.id}`).join('、')
  return `分镜表里没有这些镜头：${unknown.join('、')}。没有铺首帧，也没有登记授权。shotIds 填分镜表的镜头 id，不是首帧节点或素材节点 id；这张分镜表的镜头是：${listed}。出整张表的首帧时不传 shotIds。请改正参数后在这一轮重新调用。`
}
function missingAssetsMessage(
  missing: readonly { id: string; name: string }[],
  direct: boolean,
  shotIds: readonly string[] | undefined,
): string {
  const names = missing.map((asset) => `${asset.name}（${asset.id}）`).join('、')
  const ids = JSON.stringify(missing.map((asset) => asset.id))
  const next = direct
    ? `这一轮是直接出图：现在就在同一轮里调用 runNodes（nodeIds: ${ids}，stage: "素材"）发起素材阶段，它会直接开跑，不需要用户确认，不要停下来只向用户转述。`
    : `现在就在同一轮里调用 runNodes（nodeIds: ${ids}，stage: "素材"）提出素材阶段授权，由用户在确认卡上确认。`
  return `先出素材、再出首帧：分镜表引用的素材还没有图：${names}。首帧没有铺，也没有登记授权，没有扣费。${next}素材没写提示词时按素材描述出图；画布上已有合适的图就改用 importCanvasImage 收进素材。素材批跑完后系统会唤醒你，那时再调用 runStoryboardFrames${shotIds ? `，并沿用这次的 shotIds（${JSON.stringify(shotIds)}），不要扩大到整张分镜表` : ''}。`
}
/** 同一调用 ID 已登记的提案。不是这张分镜表的首帧阶段时按提案冲突处理，不能冒充重放。 */
async function priorFrameProposal(
  userId: string,
  conversationId: string,
  proposalKey: string,
  storyboardId: string,
  tx?: BffTransaction,
): Promise<StageAuthorization | undefined> {
  const prior = await readStageProposal(userId, conversationId, proposalKey, tx)
  if (!prior) return undefined
  if (prior.stage !== '首帧' || prior.storyboard?.storyboardId !== storyboardId)
    throw new StageAuthorizationError('stage_authorization_conflict')
  return prior
}
/**
 * 重放同一次调用时返回首次登记的授权。镜头表摘要按当前画布重算；
 * 镜头表已经改过（指纹不同）就不附摘要，确认时也会因过时被拒。
 */
function replayedStoryboard(
  doc: Y.Doc,
  authorization: StageAuthorization,
): StageStoryboard | undefined {
  const ref = authorization.storyboard
  if (!ref) return undefined
  const board = readCanvasDocument(doc).nodes.find((node) => node.id === ref.storyboardId)
  if (board?.type !== 'storyboard' || storyboardFingerprint(board.data.shots) !== ref.fingerprint)
    return undefined
  return { ref, summary: storyboardStageSummary(board.id, board.data.shots) }
}

export const runStoryboardFrames = defineAgentTool({
  name: 'runStoryboardFrames',
  label: '首帧阶段',
  modes,
  available,
  onError: 'continue',
  guidance:
    '分镜表出首帧只用本工具，顺序是先素材、后首帧：分镜表引用的人物、地点素材都有图之后再调用；素材还没有图时，先用 runNodes（stage 写「素材」）出素材，素材批跑完系统会唤醒你，那时再调用本工具。首帧节点由本工具自己铺：不要用 createNodes、connectNodes 手工搭首帧节点，也不要对首帧节点用 runNodes。默认 mode 为 grid，宫格一次出图再切分；用户要求某一镜单独重出时传 shotIds（逐镜），shotIds 填分镜表镜头 id，不是首帧节点 id。素材缺图时本工具不铺节点也不登记授权，回执会列出缺图的素材节点：照回执在同一轮接着用 runNodes 发起素材阶段，不要停下来只向用户转述；画布上已有合适的图就用 importCanvasImage 收进素材。这条授权一经确认，分镜表就定稿。只有查到 taskIds 才能说已提交，读到真实结果才能说已完成。',
  description:
    '按分镜表铺首帧：每镜一个首帧节点，宫格模式另建宫格节点；首帧与宫格连上该镜人物、地点素材作为参考，再为本次要出图的节点登记首帧阶段授权，附镜头表摘要（镜数、总时长、每镜一句）。确认授权即把分镜表定稿；提案后镜头表被改过，确认会失败，需要重新提案。直接出图开着时原标签页立即确认并开跑。素材缺图时整次拒绝。',
  parameters: Type.Object({
    storyboardId: id,
    mode: Type.Optional(Type.Union([Type.Literal('grid'), Type.Literal('individual')])),
    shotIds: Type.Optional(
      Type.Array(id, {
        minItems: 1,
        maxItems: 200,
        uniqueItems: true,
        description:
          '只重出这几镜时传：分镜表镜头 id（readCanvas 里分镜表 shots[].id，照抄），不是首帧节点 id。出整张分镜表的首帧时不传。',
      }),
    ),
  }),
  call: () => ({ title: '首帧阶段' }),
  execute: (context) => async (callId, params) => {
    if (!available(context.mode, context)) invalid('当前会话没有可用的云端节点画布。')
    const project = await agentCanvasProject(context)
    if (!project || !context.userId) return invalid('当前会话没有已同步的云端项目。')
    const userId = context.userId
    if (params.shotIds && params.mode === 'grid')
      invalid('单镜重出首帧只能逐镜：传 shotIds 时 mode 用 individual 或不填。')
    const mode: StoryboardFrameMode = params.shotIds ? 'individual' : (params.mode ?? 'grid')
    await context.assertExecution?.()
    const load = async () => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, await accessCanvasDocument(userId, project.id))
      return doc
    }
    // 先在副本上校验：缺素材、镜头不存在或提示词超长时，画布上什么也不留。
    const before = await load()
    let fingerprint: string
    try {
      // 同一次调用已登记过：跳过按当前画布的预检，交给画布命令先核对调用参数，再在重放里取回原授权。
      const prior = await priorFrameProposal(
        userId,
        context.conversationId,
        `${context.turnId}:${callId}`,
        params.storyboardId,
      )
      if (prior?.storyboard) fingerprint = prior.storyboard.fingerprint
      else {
        const board = getNode(before, params.storyboardId)
        if (board.type !== 'storyboard') return invalid(`节点不是分镜表：${params.storyboardId}`)
        if (!board.data.shots.length)
          return invalid('分镜表还没有镜头，先用 applyScriptPlan 写镜头。')
        const known = new Set(board.data.shots.map((shot) => shot.id))
        const shotIds = storyboardShotIds(readCanvasDocument(before).nodes, board, params.shotIds)
        const unknown = (shotIds ?? []).filter((shot) => !known.has(shot))
        if (unknown.length) invalid(unknownShotsMessage(board, unknown))
        const missing = storyboardMissingAssetNodes(before, board.id, shotIds)
        if (missing.length)
          invalid(missingAssetsMessage(missing, canvasStageRunsDirectly(context.params), shotIds))
        fingerprint = storyboardFingerprint(board.data.shots)
        prepareFrames(before, board.id, mode, scratchOrigin)
      }
    } finally {
      before.destroy()
    }
    // 铺节点与登记授权在同一事务里：计价或提案失败时，本次铺出或改动的节点一起回滚。
    let proposed: { authorization: StageAuthorization; storyboard?: StageStoryboard } | undefined
    await proposing(() =>
      executeCanvasCommand(
        userId,
        project.id,
        { turnId: context.turnId, toolCallId: callId, label: '铺首帧', args: params },
        (doc, origin) => {
          const board = getNode(doc, params.storyboardId)
          if (
            board.type !== 'storyboard' ||
            storyboardFingerprint(board.data.shots) !== fingerprint
          )
            invalid('分镜表刚被改过，请重新读取后再发起首帧阶段。')
          prepareFrames(doc, params.storyboardId, mode, origin)
        },
        async (tx, state, replay) => {
          const saved = new Y.Doc()
          try {
            Y.applyUpdate(saved, state)
            if (replay) {
              // 首次执行已在同一事务里登记了授权，这里只取回它。
              const prior = await priorFrameProposal(
                userId,
                context.conversationId,
                `${context.turnId}:${callId}`,
                params.storyboardId,
                tx,
              )
              if (!prior) return invalid('首帧阶段授权没有登记，请重新读取画布后再试。')
              const storyboard = replayedStoryboard(saved, prior)
              proposed = { authorization: prior, ...(storyboard ? { storyboard } : {}) }
              return
            }
            const graph = readCanvasDocument(saved)
            const board = graph.nodes.find((node) => node.id === params.storyboardId)
            if (
              board?.type !== 'storyboard' ||
              storyboardFingerprint(board.data.shots) !== fingerprint
            )
              return invalid('分镜表刚被改过，请重新读取后再发起首帧阶段。')
            const shotIds = storyboardShotIds(graph.nodes, board, params.shotIds)
            // 预检之后素材可能被删掉或换掉：在要提交的画布上再核一次，缺图就整次回滚，不铺节点也不登记授权。
            const missing = storyboardMissingAssetNodes(saved, board.id, shotIds)
            if (missing.length)
              return invalid(
                missingAssetsMessage(missing, canvasStageRunsDirectly(context.params), shotIds),
              )
            // 铺节点是幂等的：在要保存的画布副本上再跑一次只为拿到节点 ID，不写回。
            const persisted = new Set(graph.nodes.map((node) => node.id))
            const prepared = prepareFrames(saved, board.id, mode, scratchOrigin)
            const wanted = shotIds ? new Set(shotIds) : undefined
            const targets = wanted
              ? board.data.shots.flatMap((shot, index) =>
                  wanted.has(shot.id) ? [prepared.frameIds[index]!] : [],
                )
              : prepared.generateIds
            if (!targets.length || targets.some((target) => !persisted.has(target)))
              return invalid('首帧节点没有保存下来，请重新读取画布后再试。')
            const nodes = targets.map(
              (target) =>
                graph.nodes.find((node) => node.id === target) ?? invalid('首帧节点不存在。'),
            )
            const storyboard: StageStoryboard = {
              ref: { storyboardId: board.id, fingerprint },
              summary: storyboardStageSummary(board.id, board.data.shots),
            }
            const authorization = await proposeStageAuthorizationInTransaction(
              tx,
              stageProposalInput(context, callId, project.id, graph, nodes, '首帧', storyboard),
            )
            proposed = { authorization, storyboard }
          } finally {
            saved.destroy()
          }
        },
      ),
    )
    if (!proposed) return invalid('首帧阶段授权没有登记，请重新读取画布后再试。')
    return canvasStageResult(context, project.id, proposed.authorization, proposed.storyboard)
  },
})

export const applyScriptPlan = defineAgentTool({
  name: 'applyScriptPlan',
  label: '拆分剧本',
  modes,
  available,
  onError: 'continue',
  guidance:
    '用户要求拆剧本、继续完善或扩写第 N 集时使用。先读取原分镜表，storyboardId 使用原表 ID；shots 提交完整的新镜头表，保留已有镜头 ID，新增镜头使用新 ID，省略的镜头会删除。assets 只列新素材。episodeNumber 指定集号，episode 只用于追加尚不存在的剧本文字。不生成媒体，不计费。',
  description:
    '创建或就地更新一集的唯一分镜表，保留原镜头身份，可增删镜头；定稿后修改会回到草稿，旧首帧和视频保留但过期。可同时新建无图素材或追加下一集剧本文字。',
  parameters: Type.Object({
    scriptNodeId: Type.String({
      minLength: 1,
      maxLength: 128,
      description:
        '画布上已有的文本剧本节点 ID（照抄 readCanvas）；剧本还不在画布上时先用 createNodes 建一个 text 节点放剧本。',
    }),
    storyboardId: id,
    episodeNumber: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    assets: Type.Array(
      Type.Object({
        id,
        kind: Type.Union([
          Type.Literal('person'),
          Type.Literal('location'),
          Type.Literal('prop'),
          Type.Literal('product'),
        ]),
        name: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.String({ maxLength: 4000 }),
      }),
      { maxItems: 40 },
    ),
    shots: Type.Array(
      Type.Object({
        id,
        description: Type.String({ minLength: 1, maxLength: 10000 }),
        dialogue: Type.Optional(Type.String({ maxLength: 10000 })),
        camera: Type.Optional(Type.String({ maxLength: 200 })),
        durationSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
        lookIds: Type.Array(id, { maxItems: 8 }),
        locationId: Type.Optional(id),
      }),
      { maxItems: 200 },
    ),
    episode: Type.Optional(
      Type.Object({
        number: Type.Integer({ minimum: 2, maximum: 200 }),
        text: Type.String({ minLength: 1, maxLength: 100000 }),
      }),
    ),
  }),
  call: () => ({ title: '拆分剧本' }),
  execute: (context) => async (callId, params) => {
    if (!available(context.mode, context)) invalid('当前会话不能拆分剧本。')
    const selectedModel = context.params?.video?.model
    const video = agentVideoModel(selectedModel)
    if (selectedModel && (!video || !video.support.firstFrame))
      invalid('当前所选视频模型不可用或不支持首帧视频，请选择可用的首帧视频模型后再写分镜表。')
    if (video?.support.firstFrame) {
      const maximum = Math.max(...video.support.durations)
      for (const [index, shot] of params.shots.entries())
        if ((shot.durationSeconds ?? 5) > maximum)
          invalid(
            `第 ${index + 1} 镜 ${shot.id} 时长超过 ${video.support.label} 的 ${maximum} 秒上限，请在分镜表里拆镜，保留原镜头 ID 并为新增镜头分配新 ID。`,
          )
    }
    return write(context, callId, '拆分剧本', params, (doc, origin) => {
      const script = getNode(doc, params.scriptNodeId)
      const scriptText = textData(script)
      const snapshot = readCanvasDocument(doc)
      const existingBoard = snapshot.nodes.find((node) => node.id === params.storyboardId)
      if (existingBoard && existingBoard.type !== 'storyboard')
        invalid(`节点不是分镜表：${params.storyboardId}`)
      const boundEpisode =
        existingBoard?.type === 'storyboard' ? existingBoard.data.episode : undefined
      const episodeNumber =
        params.episodeNumber ?? params.episode?.number ?? boundEpisode?.number ?? 1
      if (params.episode && params.episode.number !== episodeNumber)
        invalid('追加的剧本集号必须与分镜表的 episodeNumber 一致。')
      if (
        boundEpisode &&
        (boundEpisode.scriptNodeId !== script.id || boundEpisode.number !== episodeNumber)
      )
        invalid(
          `分镜表 ${params.storyboardId} 已属于原剧本第 ${boundEpisode.number} 集，请更新该集原表。`,
        )
      const duplicate = snapshot.nodes.find(
        (node) =>
          node.type === 'storyboard' &&
          node.id !== params.storyboardId &&
          (node.data.episode?.number ?? 1) === episodeNumber,
      )
      if (duplicate)
        invalid(
          `第 ${episodeNumber} 集已有生效分镜表 ${duplicate.id}，请用此 storyboardId 更新原表，不要新建第二张表。`,
        )
      const taken = new Set(snapshot.nodes.map((node) => node.id))
      taken.add(params.storyboardId)
      for (const asset of params.assets) {
        if (taken.has(asset.id)) invalid(`节点 id 已存在：${asset.id}`)
        taken.add(asset.id)
      }
      const kinds = new Map(params.assets.map((asset) => [asset.id, asset.kind]))
      for (const node of readCanvasDocument(doc).nodes)
        if (
          node.type === 'image' &&
          node.data.meta?.nodeKind === 'asset' &&
          node.data.meta.assetKind
        )
          kinds.set(node.id, node.data.meta.assetKind as (typeof params.assets)[number]['kind'])
      for (const shot of params.shots) {
        for (const look of shot.lookIds)
          if (kinds.get(look) !== 'person') invalid(`人物引用不存在：${look}`)
        if (shot.locationId && kinds.get(shot.locationId) !== 'location')
          invalid(`地点引用不存在：${shot.locationId}`)
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
      if (!isCanvasStoryboardData({ shots })) invalid('分镜表不合法。')
      if (params.episode) {
        const next =
          appendScriptEpisode(scriptText.text, params.episode.number, params.episode.text) ??
          invalid(`第 ${params.episode.number} 集已经在剧本里，或正文是空的。`)
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
      const updatedBoard = getNode(doc, params.storyboardId)
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
        invalid('分镜表没有写入。')
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
          invalid(`素材无法连接到分镜表：${asset.id}`)
        nextY += size.height + 48
      }
      if (
        !readCanvasDocument(doc).edges.some(
          (edge) => edge.source === script.id && edge.target === params.storyboardId,
        ) &&
        !connectCanvasNodes(doc, { source: script.id, target: params.storyboardId }, origin)
      )
        invalid('剧本无法连接到分镜表。')
    })
  },
})
