import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentToolArtifact,
  ChannelMedia,
  PersistedVideoRequest,
} from '@image-playground/shared'
import { config } from '../../../config'
import { resolveQueueModel } from '../../channels'
import { awaitQueueTask, type CreateQueueTaskOutcome, createQueueTask } from '../../taskSubmission'
import type { AgentToolContext, AgentToolDetails } from './types'

interface MediaWords {
  /** 「生图」/「生视频」。 */
  readonly verb: string
  /** 「3 张图」/「1 段视频」。 */
  readonly unit: string
  /** 模型下一轮指认这件产物时用的词。 */
  readonly label: string
  /** 「这张图」/「这段视频」。 */
  readonly one: string
}

const WORDS: Record<ChannelMedia, MediaWords> = {
  image: { verb: '生图', unit: '张图', label: '图片', one: '这张图' },
  video: { verb: '生视频', unit: '段视频', label: '视频', one: '这段视频' },
}

function refusal(kind: CreateQueueTaskOutcome['kind'], words: MediaWords): string {
  if (kind === 'insufficient_credits') return `积分不够，${words.one}没有提交`
  if (kind === 'quota_exceeded') return '今天的生成次数已经用完'
  if (kind === 'authentication_required') return `${words.verb}需要先登录`
  return `${words.verb}任务没能提交`
}

export interface QueueTaskInput {
  readonly media: ChannelMedia
  readonly prompt: string
  readonly inputImages?: readonly string[]
  readonly mask?: string
  /** 视频档位；缺席即这是一条图片任务。 */
  readonly video?: PersistedVideoRequest
  /** 产出落画布时贴着这个对象放。 */
  readonly anchorImageId?: string
}

/** 该介质的模型；运营没指定就取内置 channel 里这一介质的第一个。 */
export function resolveAgentModel(media: ChannelMedia) {
  const configured = media === 'video' ? config.agent.videoModel : config.agent.imageModel
  return resolveQueueModel(media, configured || undefined)
}

/** 提交进现有队列，然后等它跑完。失败一律抛，由轮翻译成用户看得懂的一句话。 */
export async function runQueueTask(
  context: AgentToolContext,
  input: QueueTaskInput,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<AgentToolDetails>) => void) | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
  const words = WORDS[input.media]
  const target = resolveAgentModel(input.media)
  if (!target) throw new Error(`暂时没有可用的${words.verb}模型`)

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
    ...(output.duration_seconds !== undefined ? { durationSeconds: output.duration_seconds } : {}),
  }))
  context.images.note(artifacts)

  return {
    content: [
      {
        type: 'text',
        text: `已生成 ${artifacts.length} ${words.unit}并放到画布上，${words.label} id：${artifacts
          .map((artifact) => artifact.artifactId)
          .join(', ')}`,
      },
    ],
    details: {
      artifacts,
      ...(input.anchorImageId ? { anchorImageId: input.anchorImageId } : {}),
    },
  }
}
