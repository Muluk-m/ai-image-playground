import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentToolArtifact,
  AgentTurnParams,
  ChannelMedia,
  PersistedVideoRequest,
  QueueProvider,
} from '@image-playground/shared'
import { projectArtifactId } from '@image-playground/shared'
import { config } from '../../../config'
import { resolveQueueModel } from '../../channels'
import type { ExtractedResult } from '../../extractImages'
import { type CreateQueueTaskOutcome, createQueueTask } from '../../taskSubmission'
import type { MaskedEditContent, MaskedOperation, MaskedSubmission } from '../masked-plan'
import { AgentToolError, queueRefusalCode } from './errors'
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

function refusal(kind: CreateQueueTaskOutcome['kind'], words: MediaWords): string {
  if (kind === 'price_unavailable') return `这个${words.verb}模型暂时不可用`
  if (kind === 'insufficient_credits') return `积分不够，这${words.unit}没有提交`
  if (kind === 'quota_exceeded') return '今天的生成次数已经用完'
  if (kind === 'authentication_required') return `${words.verb}需要先登录`
  return `${words.verb}任务没能提交`
}

export interface QueueTarget {
  readonly provider: QueueProvider
  readonly model: string
}

export interface QueueTaskInput {
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
  /** 产出落画布时贴着这个画布对象放。 */
  readonly anchorObjectId?: string
  /**
   * 成功后要不要唤醒智能体回来复核（失败一律唤醒）。模型在提交时自己选；局部改图的候选
   * 必须复核，由改图工具定死。
   */
  readonly review?: boolean
}

/**
 * 后台任务提交成功时给模型的那句话。结果此刻还不存在，模型最容易犯的错是顺口说「画好了」，
 * 所以这里把「没好」和「什么时候能看到」一起说清。
 */
function backgroundText(words: MediaWords, count: number, taskId: string, review: boolean): string {
  const after = review
    ? '任务结束后系统会唤醒你来复核结果。'
    : '失败时系统会唤醒你向用户说明；成功时用户下次说话你会在对话记录里看到结果。'
  return `已提交后台${words.verb}任务（${count} ${words.unit}），结果尚未就绪。任务在后台生成，完成后自动放到用户的画布上；${after}结果出来之前不要说已经生成好，也不要描述成品的样子。任务 id：${taskId}`
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
 * 提交进现有队列，提交完就返回（后台任务）：结果等任务结束后按产物交付落画布，要不要唤醒智能体
 * 回来看由 `wake.ts` 判断。提交失败一律抛，由轮翻译成用户看得懂的一句话。
 */
export async function runQueueTask(
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
      '这个编辑操作已经提交，请先检查候选；不要自行付费重试',
    )
  if (approval === 'outside-batch')
    throw new AgentToolError(
      'invalid_params',
      '本轮编辑计划已经执行，不能自行追加生成；请检查已有候选并等待用户指示',
    )

  if (signal?.aborted) throw new AgentToolError('cancelled', '这一轮被中止了')
  const submitted = await createQueueTask({
    provider: target.provider,
    model: target.model,
    request: {
      prompt: input.prompt,
      device_id: context.deviceId,
      // 视频档位由 input.video 自己带，图片参数对它没有意义。
      ...(input.media === 'image' ? queueParamsFor(target.provider, context.params) : {}),
      n: input.media === 'image' ? agentImageCount(input) : 1,
      ...(input.inputImages?.length ? { input_images: [...input.inputImages] } : {}),
      ...(input.mask ? { mask: input.mask } : {}),
    },
    ...(input.video ? { video: input.video } : {}),
    userId: context.userId,
    agent: {
      conversationId: context.conversationId,
      turnId: context.turnId,
      job: {
        toolCallId: input.toolCallId ?? '',
        wakeOnSuccess: review,
        ...(context.maskedEditPlan ? { plan: context.maskedEditPlan.carryAfter(submission) } : {}),
      },
    },
  })
  if (submitted.kind !== 'created') {
    const code = queueRefusalCode(submitted.kind)
    if (submitted.kind === 'invalid_input_image') throw new AgentToolError(code, submitted.message)
    throw new AgentToolError(code, refusal(submitted.kind, words))
  }

  // 任务真的建出来了才登记：失败的提交不占批次名额，也不算这条内容提交过。
  context.maskedEditPlan?.submitted(submission)
  // 停止只停这段回复：任务已经交给队列，不随这一轮中止，删除会话时才一并取消。
  const count = input.media === 'image' ? agentImageCount(input) : 1
  return {
    content: [{ type: 'text', text: backgroundText(words, count, submitted.taskId, review) }],
    details: {
      executedPrompt: input.prompt,
      job: { taskId: submitted.taskId, media: input.media, ...(review ? { review: true } : {}) },
      ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
    },
  }
}
