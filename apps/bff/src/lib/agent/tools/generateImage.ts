import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentToolImage } from '@image-playground/shared'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Type } from 'typebox'
import { config } from '../../../config'
import { db, schema } from '../../../db/client'
import { resolveImageQueueModel } from '../../channels'
import { extractMeta } from '../../extractImages'
import { asQueueProvider } from '../../queueProvider'
import { createQueueTask } from '../../taskSubmission'
import type { AgentToolContext, AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description: '完整描述要画的画面，包含主体、场景与风格。用用户说话的语言写。',
  }),
})

interface Polling {
  readonly intervalMs: number
  readonly budgetMs: number
}

const DEFAULT_POLLING: Polling = {
  intervalMs: 1_000,
  budgetMs: QUEUE_TIMEOUTS.POLL_MAX_MS,
}

let polling = DEFAULT_POLLING

/** 测试注入点；不传恢复真实节奏。 */
export function setAgentImagePollingForTesting(next?: Partial<Polling>): void {
  polling = next ? { ...DEFAULT_POLLING, ...next } : DEFAULT_POLLING
}

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  const trimmed = typeof prompt === 'string' ? prompt.trim().replace(/\s+/g, ' ') : ''
  if (!trimmed) return '生图'
  return trimmed.length <= TITLE_MAX_CHARS ? trimmed : `${trimmed.slice(0, TITLE_MAX_CHARS - 1)}…`
}

/** 提交进现有队列，然后轮询到终态。失败一律抛，由轮翻译成用户看得懂的一句话。 */
async function generate(
  context: AgentToolContext,
  prompt: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<AgentToolDetails>) => void) | undefined,
): Promise<AgentToolResult<AgentToolDetails>> {
  const label = title({ prompt })
  const target = resolveImageQueueModel(config.agent.imageModel || undefined)
  if (!target) throw new Error('这个部署没有可用的生图模型')

  const outcome = await createQueueTask({
    provider: target.provider,
    model: target.model,
    request: { prompt, n: 1, device_id: context.deviceId },
    userId: context.userId,
    pricing: { quantity: 1, unitMultiplier: 1 },
    quotaUnits: 1,
    agent: { conversationId: context.conversationId, turnId: context.turnId },
  })
  if (outcome.kind !== 'created') throw new Error(submissionRefusal(outcome.kind))

  onUpdate?.({ content: [], details: { title: label, stage: 'submitted' } })
  const images = await awaitTaskImages(outcome.taskId, target.model, signal, () => {
    onUpdate?.({ content: [], details: { title: label, stage: 'running' } })
  })

  return {
    content: [
      {
        type: 'text',
        text: `已生成 ${images.length} 张图并放到画布上，图片 id：${images
          .map((image) => image.imageId)
          .join(', ')}`,
      },
    ],
    details: { title: label, images },
  }
}

function submissionRefusal(kind: string): string {
  if (kind === 'insufficient_credits') return '积分不够，这张图没有提交'
  if (kind === 'quota_exceeded') return '今天的生成次数已经用完'
  if (kind === 'authentication_required') return '生图需要先登录'
  return '生图任务没能提交'
}

async function awaitTaskImages(
  taskId: string,
  model: string,
  signal: AbortSignal | undefined,
  onRunning: () => void,
): Promise<AgentToolImage[]> {
  const deadline = Date.now() + polling.budgetMs
  let announcedRunning = false
  while (true) {
    if (signal?.aborted) throw new Error('这一轮被中止了')
    const [task] = await db
      .select({
        status: schema.tasks.status,
        provider: schema.tasks.provider,
        result_payload: schema.tasks.result_payload,
        error_message: schema.tasks.error_message,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1)
    if (!task) throw new Error('生图任务丢失了')

    if (task.status === 'failed') throw new Error(task.error_message ?? '生图失败')
    if (task.status === 'cancelled') throw new Error('生图任务被取消了')
    if (task.status === 'completed') {
      const provider = asQueueProvider(task.provider)
      const meta = provider ? extractMeta(provider, task.result_payload) : { images: [] }
      if (meta.images.length === 0) throw new Error('生成完成但没有返回图片')
      return meta.images.map((image) => ({
        // 画布对象与结果卡共用这个 id，点卡才能定位到同一个对象。
        imageId: `agent_${crypto.randomUUID()}`,
        taskId,
        outputIndex: image.index,
        mime: image.mime,
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
      }))
    }
    if (task.status === 'in_progress' && !announcedRunning) {
      announcedRunning = true
      onRunning()
    }
    if (Date.now() > deadline) throw new Error(`${model} 超时未返回`)
    await Bun.sleep(polling.intervalMs)
  }
}

export const generateImage: AgentToolDefinition = {
  name: 'generateImage',
  title,
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
