import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentToolArtifact,
  AgentTurnParams,
  ChannelMedia,
  PersistedVideoRequest,
  QueueProvider,
} from '@image-playground/shared'
import { AGENT_ARTIFACT_NOUN, projectArtifactId } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { config } from '../../../config'
import { schema } from '../../../db/client'
import { cancelTasks } from '../../../db/task-transitions'
import { resolveQueueModel } from '../../channels'
import { awaitQueueTask, type CreateQueueTaskOutcome, createQueueTask } from '../../taskSubmission'
import type { MaskedEditContent, MaskedOperation, MaskedSubmission } from '../masked-plan'
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

/** 没有可用模型时的那一句；工具的可用性判定与执行都从这里拿，两处不会各说各的。 */
export function noModelMessage(media: ChannelMedia): string {
  return `暂时没有可用的${WORDS[media].verb}模型`
}

/** 提交进现有队列，然后等它跑完。失败一律抛，由轮翻译成用户看得懂的一句话。 */
export async function runQueueTask(
  context: AgentToolContext,
  input: QueueTaskInput,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<AgentToolDetails>) => void) | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
  const words = WORDS[input.media]
  const target = input.target ?? resolveAgentModel(input.media, context.params?.model)
  if (!target) throw new Error(noModelMessage(input.media))

  const hasSelection = context.images.masked
  if (hasSelection) context.maskedEditPlan?.protect()
  const maskedTurn = input.media === 'image' && (hasSelection || context.maskedEditPlan?.protected)
  if (maskedTurn && !input.inputImages?.length)
    throw new Error('本轮存在用户选区，请使用改图工具核对目标与参考，不能改为无参考生图')
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
    throw new Error('这个编辑操作已经提交，请先检查候选；不要自行付费重试')
  if (approval === 'outside-batch')
    throw new Error('本轮编辑计划已经执行，不能自行追加生成；请检查已有候选并等待用户指示')

  if (signal?.aborted) throw new Error('这一轮被中止了')
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
    agent: { conversationId: context.conversationId, turnId: context.turnId },
  })
  if (submitted.kind !== 'created') {
    if (submitted.kind === 'invalid_input_image') throw new Error(submitted.message)
    throw new Error(refusal(submitted.kind, words))
  }

  // 任务真的建出来了才登记：失败的提交不占批次名额，也不算这条内容提交过。
  context.maskedEditPlan?.submitted(submission)
  onUpdate?.({ content: [], details: { stage: 'submitted' } })
  const outcome = await awaitQueueTask(submitted.taskId, {
    signal,
    onStatus: (status) => {
      if (status === 'in_progress') onUpdate?.({ content: [], details: { stage: 'running' } })
    },
  }).catch(async (error) => {
    if (signal?.aborted) {
      await cancelTasks(
        and(
          eq(schema.tasks.id, submitted.taskId),
          eq(schema.tasks.agent_turn_id, context.turnId),
          eq(schema.tasks.agent_conversation_id, context.conversationId),
        )!,
      )
    }
    throw error
  })
  if (outcome.kind !== 'completed') throw new Error(outcome.reason)

  const artifacts: AgentToolArtifact[] = outcome.result.images.map((output) => ({
    // 画布对象与结果卡共用这个 id，点卡才能定位到同一个对象。
    artifactId: projectArtifactId(submitted.taskId, output.index),
    media: input.media,
    taskId: submitted.taskId,
    outputIndex: output.index,
    mime: output.mime,
    ...(output.width !== undefined ? { width: output.width } : {}),
    ...(output.height !== undefined ? { height: output.height } : {}),
  }))
  context.images.note(artifacts)

  return {
    content: [
      {
        type: 'text',
        text: `已生成 ${artifacts.length} ${words.unit}${input.mask ? '候选（仍需检查选区内效果与边缘）' : ''}并放到画布上，${
          AGENT_ARTIFACT_NOUN[input.media]
        } id：${artifacts.map((artifact) => artifact.artifactId).join(', ')}`,
      },
    ],
    details: {
      executedPrompt: input.prompt,
      artifacts,
      ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
    },
  }
}
