import {
  type CanvasNode,
  canvasNodeKind,
  canvasStageRunsDirectly,
  parseCompleteStageVideoDraft,
  resolveStageImageExecution,
  resolveStageVideoExecution,
  type StageAuthorization,
  type StageAuthorizationTurn,
  type StageExecutionBinding,
  stageExecutionBinding,
} from '@image-playground/shared'
import { resolveAgentModel } from '../../../../lib/agent/model-resolution'
import {
  readStageProposal,
  StageAuthorizationError,
  type StageChargeInput,
  type StageProposalInput,
} from '../../../../lib/agent/stage-authorizations'
import {
  agentVideoAvailable,
  agentVideoModels,
  videoNodeModeRejection,
} from '../../../../lib/agent/video-models'
import { isCapabilityEnabled } from '../../../../lib/capabilities'
import { declaredImageSizes } from '../../../../lib/channels'
import { isActiveMember } from '../../../../lib/gpt-membership'
import type { BffTransaction } from '../../../../lib/private-overlay'
import {
  type CanvasGraph,
  canvasStageNodeName,
  type StageStoryboardSummaryRef,
} from '../../../canvas'
import type { AgentToolContext } from '../../contracts'
import { invalidCanvasToolParam, throwNoVideoModel } from './node-shared'

function stageExecution(
  node: CanvasNode,
  params:
    | {
        model?: string
        canvasImageModel?: string
        canvasImageCount?: number
        n?: number
        size?: string
        quality?: string
        gemini_image_size?: string
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
  member: boolean,
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
  // 页面上没有可用视频模型时，原标签页一定拦在「模型不可用」上：这里就不报价、不登记授权。
  if (videoKind && !agentVideoAvailable()) throwNoVideoModel()
  const channels = agentVideoModels().map((option) => ({
    modelId: option.target.model,
    support: option.support,
  }))
  const resolved =
    globalDraft &&
    resolveStageVideoExecution({
      meta,
      references: graph.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => ({ id: edge.source })),
      globalDraft,
      options: channels,
    })
  // 节点写明的模式在实际会用的模型上不支持时，以前会悄悄退成首帧（图生视频）照样报价、扣视频积分。
  const requestedMode = meta.nodeVideoMode
  if (resolved && requestedMode !== undefined && resolved.mode !== requestedMode)
    invalidCanvasToolParam(
      `节点「${canvasStageNodeName(node)}」：${
        videoNodeModeRejection(
          requestedMode,
          parseCompleteStageVideoDraft(meta.nodeVideoDraft)?.model ?? globalDraft?.model,
        ) ?? `视频模式 ${requestedMode} 当前不可用。`
      }`,
    )
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
  const imageModel =
    params?.canvasImageModel?.trim() || resolveAgentModel('image', params?.model)?.model
  const image = resolveStageImageExecution({
    model: imageModel,
    count: params?.canvasImageCount ?? params?.n,
    storyboardRole: meta.storyboardRole,
    size: params?.size,
    quality: params?.quality,
    imageSize: params?.gemini_image_size,
    supportedTiers: imageModel ? declaredImageSizes(imageModel) : undefined,
    member,
  })
  return { ...(image ? { charge: { nodeId: node.id, ...image } } : {}), binding }
}

/** 按节点规格冻结报价与执行快照。只读画布，不写库。 */
function quoteCanvasStage(
  context: AgentToolContext,
  graph: CanvasGraph,
  nodes: readonly CanvasNode[],
  member: boolean,
) {
  const billing = isCapabilityEnabled('billing:credits')
  const charges: StageChargeInput[] = []
  const bindings: StageExecutionBinding[] = []
  const authorizedIds = new Set(nodes.map((node) => node.id))
  for (const node of nodes) {
    const quoted = stageExecution(node, context.params, graph, authorizedIds, member)
    if (!quoted)
      return invalidCanvasToolParam(`无法为节点「${canvasStageNodeName(node)}」建立执行快照。`)
    bindings.push(quoted.binding)
    if (!quoted.charge) {
      if (billing)
        return invalidCanvasToolParam(
          `无法为节点「${canvasStageNodeName(node)}」计价，授权没有创建。图片需要可用的出图模型；视频需要节点上的模型与时长，或本轮视频参数。`,
        )
      charges.push({ nodeId: node.id, model: '', quantity: 1, unitMultiplier: 1 })
      continue
    }
    charges.push(quoted.charge)
  }
  return { charges, bindings }
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
    ...(params?.size ? { size: params.size } : {}),
    ...(params?.quality ? { quality: params.quality } : {}),
    ...(params?.gemini_image_size ? { gemini_image_size: params.gemini_image_size } : {}),
    ...(params?.video ? { video: params.video } : {}),
  }
}

export async function stageProposalInput(
  context: AgentToolContext,
  callId: string,
  projectId: string,
  graph: CanvasGraph,
  nodes: readonly CanvasNode[],
  stage: string,
  storyboard?: StageStoryboardSummaryRef,
): Promise<StageProposalInput> {
  const member =
    context.params?.gemini_image_size === '4K' && (await isActiveMember(context.userId))
  const { charges, bindings } = quoteCanvasStage(context, graph, nodes, member)
  return {
    userId: context.userId ?? invalidCanvasToolParam('当前会话没有已同步的云端项目。'),
    conversationId: context.conversationId,
    projectId,
    proposalKey: `${context.turnId}:${callId}`,
    stage,
    nodeIds: nodes.map((node) => node.id),
    nodeNames: nodes.map((node) => canvasStageNodeName(node)),
    nodes: charges,
    bindings,
    ...(storyboard ? { storyboard: storyboard.ref } : {}),
    turn: stageTurn(context.params),
  }
}

/** 计价不可用时给模型一句能照做的话，其他错误照常抛出。 */
export async function proposing<T>(propose: () => Promise<T>): Promise<T> {
  try {
    return await propose()
  } catch (error) {
    if (
      error instanceof StageAuthorizationError &&
      error.code === 'stage_authorization_price_unavailable'
    )
      return invalidCanvasToolParam('无法为这些节点计价，授权没有创建。请确认模型可用后再提案。')
    if (
      error instanceof StageAuthorizationError &&
      error.code === 'stage_authorization_storyboard_busy'
    )
      return invalidCanvasToolParam(
        '这张分镜表按当前镜头表的首帧阶段已经确认、正在进行，规格不同的新首帧阶段没有登记，也没有扣费。向用户说明，等这一阶段结束后再发起；不要换参数反复重试。',
      )
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
export function canvasStageResult(
  context: AgentToolContext,
  projectId: string,
  authorization: StageAuthorization,
  storyboard?: StageStoryboardSummaryRef,
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

export function missingAssetsMessage(
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
export async function priorFrameProposal(
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
