import type { AgentDraftSubmission } from '@image-playground/db'
import type {
  AgentBackgroundJob,
  AgentToolErrorCode,
  ChannelMedia,
  PersistedVideoRequest,
  QueueProvider,
  SubmitRequest,
} from '@image-playground/shared'
import { AGENT_AUTO_SUBMIT_MAX_PER_TURN } from '@image-playground/shared'
import { createQueueTask } from '../taskSubmission'
import { shapeQueuePrompt } from './prompt-shaping'
import { queueRefusalCode } from './tools/errors'

/**
 * 出图模式：生成工具拟好稿当场提交，不停在「等待确认」。
 *
 * 对话模式的那道确认门是用户唯一的花钱闸门（见 `confirmations.ts`），出图模式换掉的正是它，
 * 所以这里只做「同一份冻结材料、少一次人工点击」，不额外放宽任何东西：模型、参数、输入图、
 * 提示词加工与幂等命令 id 都与确认那条路逐字相同，费用照样在 `createQueueTask` 里预扣。
 *
 * 两条路的差别只有三件事：草稿不落 `agent_generation_drafts`（材料没有等待期，直接进任务）、
 * 卡片直接是 `submitted`、以及这一轮不会因为「拟过稿」而收尾，模型可以接着出下一张。
 */

/** 一轮里还能自动提交几次。额度是这一轮唯一的刹车，见 {@link AGENT_AUTO_SUBMIT_MAX_PER_TURN}。 */
export interface AgentAutoSubmitBudget {
  /** 领一次额度：`true` 才自动提交，`false` 表示这一轮领完了，调用方退回拟稿。 */
  take(): boolean
}

export function createAutoSubmitBudget(): AgentAutoSubmitBudget {
  let left = AGENT_AUTO_SUBMIT_MAX_PER_TURN
  return {
    take() {
      if (left <= 0) return false
      left -= 1
      return true
    },
  }
}

export interface AutoSubmitInput {
  readonly conversationId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly userId: string | null
  readonly media: ChannelMedia
  readonly provider: QueueProvider
  readonly model: string
  /** 送进上游的整份请求，输入图与遮罩此刻还是 data URL。 */
  readonly request: SubmitRequest
  readonly video?: PersistedVideoRequest
  readonly submission: AgentDraftSubmission
}

export type AutoSubmitOutcome =
  | { readonly kind: 'created'; readonly job: AgentBackgroundJob }
  | { readonly kind: 'refused'; readonly code: AgentToolErrorCode }

/**
 * 幂等命令 id。一次工具调用在一个会话里只有一个身份，所以按它拼——同一次调用被重放
 * （轮被打断后续跑、上游重发）时 `createQueueTask` 认得出那条已经建好的任务，不会再扣一次费。
 */
function commandIdOf(input: AutoSubmitInput): string {
  return `agent-auto:${input.conversationId}:${input.turnId}:${input.toolCallId}`
}

export async function submitAgentGeneration(input: AutoSubmitInput): Promise<AutoSubmitOutcome> {
  const prompt =
    input.media === 'image'
      ? shapeQueuePrompt({
          provider: input.provider,
          model: input.model,
          prompt: input.request.prompt,
          ...(input.request.size ? { size: input.request.size } : {}),
        })
      : input.request.prompt
  const submitted = await createQueueTask({
    provider: input.provider,
    model: input.model,
    request: { ...input.request, prompt, client_request_id: commandIdOf(input) },
    ...(input.video ? { video: input.video } : {}),
    userId: input.userId,
    agent: {
      conversationId: input.conversationId,
      turnId: input.turnId,
      job: {
        toolCallId: input.toolCallId,
        wakeOnSuccess: input.submission.review,
        ...(input.submission.plan ? { plan: input.submission.plan } : {}),
      },
    },
  })
  if (submitted.kind !== 'created')
    return { kind: 'refused', code: queueRefusalCode(submitted.kind) }
  return {
    kind: 'created',
    job: {
      taskId: submitted.taskId,
      media: input.media,
      ...(input.submission.videoRecord ? { video: input.submission.videoRecord } : {}),
      ...(input.submission.review ? { review: true as const } : {}),
    },
  }
}
