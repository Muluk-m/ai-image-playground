import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentToolImage } from '@image-playground/shared'
import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { config } from '../../../config'
import { resolveQueueModel } from '../../channels'
import { awaitQueueTask, type CreateQueueTaskOutcome, createQueueTask } from '../../taskSubmission'
import type { AgentToolContext, AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description: '完整描述要画的画面，包含主体、场景与风格。用用户说话的语言写。',
  }),
})

const REFUSAL: Partial<Record<CreateQueueTaskOutcome['kind'], string>> = {
  insufficient_credits: '积分不够，这张图没有提交',
  quota_exceeded: '今天的生成次数已经用完',
  authentication_required: '生图需要先登录',
}

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  return typeof prompt === 'string' && prompt.trim()
    ? agentTitleLine(prompt, TITLE_MAX_CHARS)
    : '生图'
}

/** 提交进现有队列，然后等它跑完。失败一律抛，由轮翻译成用户看得懂的一句话。 */
async function generate(
  context: AgentToolContext,
  prompt: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<AgentToolDetails>) => void) | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
  const target = resolveQueueModel('image', config.agent.imageModel || undefined)
  if (!target) throw new Error('暂时没有可用的生图模型')

  const submitted = await createQueueTask({
    provider: target.provider,
    model: target.model,
    request: { prompt, n: 1, device_id: context.deviceId },
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

  return {
    content: [
      {
        type: 'text',
        text: `已生成 ${images.length} 张图并放到画布上，图片 id：${images
          .map((image) => image.imageId)
          .join(', ')}`,
      },
    ],
    details: { images },
  }
}

export const generateImage: AgentToolDefinition = {
  name: 'generateImage',
  title,
  onError: 'abort',
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'generateImage',
      label: '生图',
      description:
        '按提示词生成一张全新的图片，产出直接落到用户的画布上。用户想要一张新图时调用它；改已有的图不用这个。',
      parameters,
      execute: (_toolCallId, params, signal, onUpdate) =>
        generate(context, params.prompt, signal, onUpdate),
    }
    return tool as AgentTool
  },
}
