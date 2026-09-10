import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentToolImage } from '@image-playground/shared'
import { config } from '../../../config'
import { resolveQueueModel } from '../../channels'
import { awaitQueueTask, type CreateQueueTaskOutcome, createQueueTask } from '../../taskSubmission'
import type { AgentToolContext, AgentToolDetails } from './types'

const REFUSAL: Partial<Record<CreateQueueTaskOutcome['kind'], string>> = {
  insufficient_credits: '积分不够，这张图没有提交',
  quota_exceeded: '今天的生成次数已经用完',
  authentication_required: '生图需要先登录',
}

export interface ImageTaskInput {
  readonly prompt: string
  readonly inputImages?: readonly string[]
  readonly mask?: string
  /** 产出落画布时贴着这个对象放。 */
  readonly anchorImageId?: string
}

/** 提交进现有队列，然后等它跑完。失败一律抛，由轮翻译成用户看得懂的一句话。 */
export async function runImageTask(
  context: AgentToolContext,
  input: ImageTaskInput,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<AgentToolDetails>) => void) | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
  const target = resolveQueueModel('image', config.agent.imageModel || undefined)
  if (!target) throw new Error('暂时没有可用的生图模型')

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
    userId: context.userId,
    agent: { conversationId: context.conversationId, turnId: context.turnId },
  })
  if (submitted.kind !== 'created') {
    throw new Error(REFUSAL[submitted.kind] ?? '生图任务没能提交')
  }

  onUpdate?.({ content: [], details: { stage: 'submitted' } })
  const outcome = await awaitQueueTask(submitted.taskId, {
    signal,
    onStatus: (status) => {
      if (status === 'in_progress') onUpdate?.({ content: [], details: { stage: 'running' } })
    },
  })
  if (outcome.kind !== 'completed') throw new Error(outcome.reason)

  const images: AgentToolImage[] = outcome.result.images.map((image) => ({
    // 画布对象与结果卡共用这个 id，点卡才能定位到同一个对象。
    imageId: `agent_${crypto.randomUUID()}`,
    taskId: submitted.taskId,
    outputIndex: image.index,
    mime: image.mime,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
  }))
  context.images.note(images)

  return {
    content: [
      {
        type: 'text',
        text: `已生成 ${images.length} 张图并放到画布上，图片 id：${images
          .map((image) => image.imageId)
          .join(', ')}`,
      },
    ],
    details: {
      images,
      ...(input.anchorImageId ? { anchorImageId: input.anchorImageId } : {}),
    },
  }
}
