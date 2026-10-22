import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core'
import type { AgentMessageView, AgentTurnParams } from '@image-playground/shared'
import { confirmedSubmissionText } from './tools/queueTask'
import type { AgentToolGateView } from './tools/types'
import type { AgentTurnContinuation } from './turn-input'

/**
 * 确认门：智能体模式里用户关掉了「直接出图」时，花钱的生成调用要等用户在卡片上确认再走。
 *
 * 门是工具层的，智能体看不见它：系统提示词、工具清单与出图模式逐字相同，被拦下的那次调用给模型的
 * 回执也与当场提交时一样。它挂在 pi 的 `beforeToolCall` 上认出要拦的调用；工具照常把请求准备齐全
 * （遮罩编辑的执行指令、输入图归档、档位与费用都要准备完才知道），只在提交那一步停住，把整份材料
 * 存成待确认的稿（`agent_generation_drafts` 加一张 `gated` 的卡，这就是持久化的待处理记录），
 * 随后这一轮不再回上游（`shouldStopAfterTurn`）。
 *
 * 之后只有两条路，与 OpenAI Agents SDK 的 `needsApproval` / RunState、Vercel AI SDK 的工具审批、
 * LangGraph 的 `interrupt` 同一个形状——持久化中断，再按记录恢复：
 *
 * - 用户确认：`confirmations.ts` 按冻结的材料提交，这一轮拦下的卡都确认完时排一次续跑；续跑把
 *   那几次调用与它们的回执接在历史末尾，`Agent.continue()` 接着往下走，不给模型任何额外说明。
 * - 用户没确认就发了新消息：这张卡作废（`voidPendingToolGates`），模型在历史里看到这次没有执行。
 *
 * pi 的 `beforeToolCall` 只能放行或拦成一条错误结果，没有挂起；Agent 的 `continue()` 要求最后一条是
 * 用户消息或工具结果。所以这里不在 `beforeToolCall` 里 block（那会把一条错误回执写进模型的上下文），
 * 而是让工具在花钱那一步停住、这一轮收尾，续跑时再把回执补成一对完整的调用与结果。
 *
 * 只拦智能体模式（chat）的生图、改图与生视频。画布的 `runNodes` 有自己的阶段授权，是第二阶段的事；
 * 制作模式的稿本来就要确认，不归这里管。
 */

/** 确认门拦的工具：都会提交一条计费的生成任务。 */
export const AGENT_GATED_TOOLS: ReadonlySet<string> = new Set([
  'generateImage',
  'editImage',
  'generateVideo',
])

/**
 * 这一轮要不要开确认门：智能体模式、用户显式关掉了直接出图（`autoSubmit: false`）、
 * 不是原话直出也不是制作模式。没带偏好的老请求仍走原来的拟稿收尾，不开门。
 */
export function agentToolGateActive(
  experience: 'chat' | 'canvas',
  params: AgentTurnParams | undefined,
): boolean {
  return (
    experience === 'chat' &&
    params?.autoSubmit === false &&
    params?.directImage !== true &&
    !params?.productionMode &&
    !params?.production
  )
}

export interface AgentToolGate {
  /** 给工具看的那一面：这一次调用是不是被拦下了。 */
  readonly view: AgentToolGateView
  /** 挂在 pi `Agent` 上的那一个钩子。 */
  beforeToolCall(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined>
}

/** 一轮一个；`active` 为假时什么都不拦。 */
export function createAgentToolGate(active: boolean): AgentToolGate {
  const holding = new Set<string>()
  return {
    view: { holds: (toolCallId) => holding.has(toolCallId) },
    async beforeToolCall({ toolCall }) {
      if (active && AGENT_GATED_TOOLS.has(toolCall.name)) holding.add(toolCall.id)
      return undefined
    },
  }
}

/**
 * 续跑要接的那几次调用：被拦下那一轮里确认过（带着提交出的任务）的确认门卡，按出现的顺序。
 * 参数取起跑时的快照，回执的提示词取用户确认的那一份。作废的卡不在其中。
 */
export function gateContinuation(turn: readonly AgentMessageView[]): AgentTurnContinuation {
  const calls = turn.flatMap((message) =>
    message.content.flatMap((block) => {
      if (block.type !== 'toolResult' || block.gated !== true || !block.job) return []
      return [
        {
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          args: block.snapshot?.args ?? (block.prompt ? { prompt: block.prompt } : {}),
          result: confirmedSubmissionText(block.job.media, block.prompt, block.gateReceipt),
        },
      ]
    }),
  )
  return { calls }
}
