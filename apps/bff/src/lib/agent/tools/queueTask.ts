import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentToolArtifact,
  AgentToolName,
  ChannelMedia,
  PersistedVideoRequest,
  QueueProvider,
  VideoGenerationRecord,
} from '@image-playground/shared'
import { projectArtifactId } from '@image-playground/shared'
import { config } from '../../../config'
import { resolveQueueModel } from '../../channels'
import type { ExtractedResult } from '../../extractImages'
import { saveGenerationDraft } from '../confirmations'
import type { MaskedEditContent, MaskedOperation, MaskedSubmission } from '../masked-plan'
import { AgentToolError } from './errors'
import { agentImageCount, queueParamsFor } from './queueParams'
import type { AgentToolContext, AgentToolDetails } from './types'

interface MediaWords {
  readonly verb: string
  readonly unit: string
}

const WORDS: Record<ChannelMedia, MediaWords> = {
  image: { verb: '生图', unit: '张图' },
  video: { verb: '生视频', unit: '段视频' },
}

export interface QueueTarget {
  readonly provider: QueueProvider
  readonly model: string
}

export interface QueueTaskInput {
  readonly toolName: AgentToolName
  readonly toolCallId?: string
  readonly maskedOperation?: MaskedOperation
  /** 这次真遮罩编辑的内容身份；缺席即这次提交不参与内容去重。 */
  readonly maskedContent?: MaskedEditContent
  readonly media: ChannelMedia
  /** 已经解析好的模型；缺席就按介质现解析。 */
  readonly target?: QueueTarget
  readonly prompt: string
  /** 图片工具选择的产出张数；与轮上的用户偏好无关。 */
  readonly n?: number
  readonly inputImages?: readonly string[]
  readonly mask?: string
  /** 视频档位；缺席即这是一条图片任务。 */
  readonly video?: PersistedVideoRequest
  /** 视频产物要标注的档位与来源图；确认提交时随任务记下。 */
  readonly videoRecord?: VideoGenerationRecord
  /** 产出落画布时贴着这个画布对象放。 */
  readonly anchorObjectId?: string
  /**
   * 成功后要不要唤醒智能体回来复核（失败一律唤醒）。模型在拟稿时自己选；局部改图的候选
   * 必须复核，由改图工具定死。
   */
  readonly review?: boolean
}

/**
 * 拟好稿之后给模型的那句话。它不会在这一轮回到模型手里（拟稿即收尾，见 `turn.ts`），
 * 但会作为历史进下一轮：那时模型要知道的是「这次没有提交，也没有花钱，等用户确认」。
 */
function draftText(words: MediaWords, count: number): string {
  return `已按用户要求拟好${words.verb}提示词（${count} ${words.unit}），提示词已原样展示给用户，等他确认。这次调用没有提交任何任务，也没有产生任何费用。用户可以直接修改提示词再点「确认生成」，届时系统按他确认的那一份原样提交。不要说已经在生成或已经生成好，也不要描述成品的样子；不要为同一件事再拟一次稿。`
}

/**
 * 该介质的模型。优先用这一轮里用户选的，解析不出来（模型下线、介质不符）就退回运营配置的，
 * 再没有就取内置 channel 里这一介质的第一个。用户选错模型不该让整轮失败。
 */
export function resolveAgentModel(
  media: ChannelMedia,
  preferred?: string,
): QueueTarget | undefined {
  if (preferred) {
    const chosen = resolveQueueModel(media, preferred)
    if (chosen) return chosen
  }
  const configured = media === 'video' ? config.agent.videoModel : config.agent.imageModel
  return resolveQueueModel(media, configured || undefined)
}

/** 一条跑完的队列任务落成的产物。同步等结果与后台任务结算走同一个算式。 */
export function queueArtifacts(
  taskId: string,
  media: ChannelMedia,
  result: ExtractedResult,
): AgentToolArtifact[] {
  return result.images.map((output) => ({
    // 画布对象与结果卡共用这个 id，点卡才能定位到同一个对象。
    artifactId: projectArtifactId(taskId, output.index),
    media,
    taskId,
    outputIndex: output.index,
    mime: output.mime,
    ...(output.width !== undefined ? { width: output.width } : {}),
    ...(output.height !== undefined ? { height: output.height } : {}),
  }))
}

/** 没有可用模型时的那一句；工具的可用性判定与执行都从这里拿，两处不会各说各的。 */
export function noModelMessage(media: ChannelMedia): string {
  return `暂时没有可用的${WORDS[media].verb}模型`
}

/**
 * 生成工具的唯一出口：请求准备齐了（模型、提示词、输入图、遮罩、档位、张数），却**不提交**，
 * 而是把这整份材料存成一份待确认的草稿，卡片停在「等待确认」。队列任务、预留与扣费都要等用户
 * 在卡上确认之后才发生（见 `confirmations.ts`）。
 *
 * 门设在这一处而不是各工具入口：草稿里的提示词必须是真正会送进上游的那一句——遮罩编辑的执行
 * 指令由服务端按用户原文与选区拼出来，模型手里的只是摘要。准备做完再拟稿，用户看到、改到的
 * 才是真正会执行的东西。
 */
export async function draftQueueTask(
  context: AgentToolContext,
  input: QueueTaskInput,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
  const words = WORDS[input.media]
  const review = input.review === true
  const target = input.target ?? resolveAgentModel(input.media, context.params?.model)
  if (!target) throw new AgentToolError('model_unavailable', noModelMessage(input.media))

  const hasSelection = context.images.masked
  if (hasSelection) context.maskedEditPlan?.protect()
  const maskedTurn = input.media === 'image' && (hasSelection || context.maskedEditPlan?.protected)
  if (maskedTurn && !input.inputImages?.length)
    throw new AgentToolError(
      'invalid_params',
      '本轮存在用户选区，请使用改图工具核对目标与参考，不能改为无参考生图',
    )
  // 批次身份只在遮罩轮上问；内容身份跟着这次编辑走，与本轮是不是遮罩轮无关。
  const submission: MaskedSubmission = {
    ...(maskedTurn
      ? {
          call: {
            toolCallId: input.toolCallId ?? '',
            ...(input.maskedOperation ? { operation: input.maskedOperation } : {}),
          },
        }
      : {}),
    ...(input.maskedContent ? { content: input.maskedContent } : {}),
  }
  const approval = context.maskedEditPlan?.approve(submission) ?? 'approved'
  if (approval === 'already-submitted')
    throw new AgentToolError(
      'invalid_params',
      '这个编辑操作已经拟过稿，请先检查候选；不要自行重复拟稿',
    )
  if (approval === 'outside-batch')
    throw new AgentToolError(
      'invalid_params',
      '本轮编辑计划已经执行，不能自行追加生成；请检查已有候选并等待用户指示',
    )

  if (signal?.aborted) throw new AgentToolError('cancelled', '这一轮被中止了')
  await context.assertExecution?.()
  const count = input.media === 'image' ? agentImageCount(input) : 1
  // 计划随草稿一起冻结：用户几分钟后才确认，那时这一轮的内存早已不在，唤醒轮要接的是提交那一刻的计划。
  const plan = context.maskedEditPlan?.carryAfter(submission)
  await saveGenerationDraft({
    conversationId: context.conversationId,
    turnId: context.turnId,
    toolCallId: input.toolCallId ?? '',
    toolName: input.toolName,
    media: input.media,
    provider: target.provider,
    model: target.model,
    prompt: input.prompt,
    request: {
      prompt: input.prompt,
      device_id: context.deviceId,
      // 视频档位由 input.video 自己带，图片参数对它没有意义。
      ...(input.media === 'image' ? queueParamsFor(target.provider, context.params) : {}),
      n: count,
      ...(input.inputImages?.length ? { input_images: [...input.inputImages] } : {}),
      ...(input.mask ? { mask: input.mask } : {}),
    },
    ...(input.video ? { video: input.video } : {}),
    submission: {
      review,
      ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
      ...(plan ? { plan } : {}),
      ...(input.videoRecord ? { videoRecord: input.videoRecord } : {}),
    },
  })
  // 草稿真的落下了才登记：同一轮里模型不能为同一件事拟第二次稿，确认与否由用户决定。
  context.maskedEditPlan?.submitted(submission)
  return {
    content: [{ type: 'text', text: draftText(words, count) }],
    details: {
      executedPrompt: input.prompt,
      awaitingConfirmation: true as const,
      ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
    },
  }
}
