import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentToolArtifact,
  ChannelMedia,
  PersistedVideoRequest,
  QueueProvider,
} from '@image-playground/shared'
import { AGENT_ARTIFACT_NOUN } from '@image-playground/shared'
import { config } from '../../../config'
import { resolveQueueModel } from '../../channels'
import { awaitQueueTask, type CreateQueueTaskOutcome, createQueueTask } from '../../taskSubmission'
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
  readonly media: ChannelMedia
  /** 已经解析好的模型；缺席就按介质现解析。 */
  readonly target?: QueueTarget
  readonly prompt: string
  readonly inputImages?: readonly string[]
  readonly mask?: string
  /** 视频档位；缺席即这是一条图片任务。 */
  readonly video?: PersistedVideoRequest
  /** 产出落画布时贴着这个画布对象放。 */
  readonly anchorObjectId?: string
}

/** 该介质的模型；运营没指定就取内置 channel 里这一介质的第一个。 */
export function resolveAgentModel(media: ChannelMedia): QueueTarget | undefined {
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
  const target = input.target ?? resolveAgentModel(input.media)
  if (!target) throw new Error(noModelMessage(input.media))

  const submitted = await createQueueTask({
    provider: target.provider,
    model: target.model,
    request: {
      prompt: input.prompt,
      n: 1,
      device_id: context.deviceId,
      ...(input.inputImages?.length ? { input_images: [...input.inputImages] } : {}),
      ...(input.mask ? { mask: input.mask } : {}),
    },
    ...(input.video ? { video: input.video } : {}),
    userId: context.userId,
    agent: { conversationId: context.conversationId, turnId: context.turnId },
  })
  if (submitted.kind !== 'created') throw new Error(refusal(submitted.kind, words))

  onUpdate?.({ content: [], details: { stage: 'submitted' } })
  const outcome = await awaitQueueTask(submitted.taskId, {
    signal,
    onStatus: (status) => {
      if (status === 'in_progress') onUpdate?.({ content: [], details: { stage: 'running' } })
    },
  })
  if (outcome.kind !== 'completed') throw new Error(outcome.reason)

  const artifacts: AgentToolArtifact[] = outcome.result.images.map((output) => ({
    // 画布对象与结果卡共用这个 id，点卡才能定位到同一个对象。
    artifactId: `agent_${crypto.randomUUID()}`,
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
        text: `已生成 ${artifacts.length} ${words.unit}并放到画布上，${
          AGENT_ARTIFACT_NOUN[input.media]
        } id：${artifacts.map((artifact) => artifact.artifactId).join(', ')}`,
      },
    ],
    details: {
      artifacts,
      ...(input.anchorObjectId ? { anchorObjectId: input.anchorObjectId } : {}),
    },
  }
}
