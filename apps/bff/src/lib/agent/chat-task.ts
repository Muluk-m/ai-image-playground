import type { AgentTurnCost, AgentTurnUsage } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { executionContext } from '../../db/execution-context'
import { finishTask } from '../../db/task-transitions'
import type {
  BffTransaction,
  ChatPricing,
  PrivateTaskHooks,
  TaskReservationFailure,
  TaskUsage,
} from '../private-overlay'
import { loadPrivateBffOverlay } from '../private-overlay'
import { AGENT_EXECUTION_LEASE_MS, agentExecutionToken } from './execution'
import type { AgentTurnSettlement } from './turn'

/** 单价表没登记这个对话模型时的兜底：预扣照样算得出，reserveTask 会以缺单价拒掉这一轮。 */
const FALLBACK_CHAT_PRICING: ChatPricing = {
  outputPriceRatio: 5,
  outputReserveTokens: 2_000,
}

/** 一轮的定价快照；内部字段只有这个模块读，调用方原样带着它走完预扣与结算。 */
export type ChatTaskPricing = ChatPricing

/** 收尾结算：写终态、按实际用量结算预扣，并回报本轮消耗。 */
export type ChatTaskSettle = (settlement: AgentTurnSettlement) => Promise<AgentTurnCost>

export interface ChatTaskReserved {
  readonly kind: 'reserved'
  readonly reservedCredits: number
  readonly settle: ChatTaskSettle
}

export type ChatTaskReservation = ChatTaskReserved | TaskReservationFailure

export interface ReserveChatTaskInput {
  /** 预扣要和调用方的业务写在同一事务里：任一步失败整笔不落地。 */
  readonly tx: BffTransaction
  readonly taskHooks: PrivateTaskHooks
  readonly conversationId: string
  /** 对话任务的 id 就是轮 id：本轮的账都挂在它上面。 */
  readonly turnId: string
  readonly userId: string
  readonly deviceId: string
  readonly model: string
  /** 起轮前估的输入 token；输出按快照里的预留上限。 */
  readonly estimatedInputTokens: number
  readonly pricing: ChatTaskPricing
}

/**
 * 取一轮的定价快照：运营中途改价不该改写在途那一轮的账，所以预扣与结算共用这一份。
 * 单价表没登记这个模型时给兜底，`reserveTask` 会在预扣那一步以缺单价拒掉这一轮。
 */
export async function chatTaskPricing(
  taskHooks: PrivateTaskHooks,
  model: string,
): Promise<ChatTaskPricing> {
  return (await taskHooks.chatPricing(model)) ?? FALLBACK_CHAT_PRICING
}

/**
 * 单价表的每单位积分数是正整数，装不下按千 token 的小数单价：把千 token 数塞进单位倍率，
 * 钩子里的「单价 × 数量 × 倍率后向上取整」才算得出输入 6 / 输出 30 这两档。
 */
function usageUnits(
  inputTokens: number,
  outputTokens: number,
  pricing: ChatTaskPricing,
  cachedInputTokens = 0,
): { quantity: number; unitMultiplier: number } {
  return {
    quantity: 1,
    unitMultiplier:
      (inputTokens -
        cachedInputTokens +
        cachedInputTokens * (pricing.cachedInputPriceRatio ?? 0) +
        outputTokens * pricing.outputPriceRatio) /
      1_000,
  }
}

/**
 * 预扣：输入按起轮前的估算，输出按预留上限。
 * 与 `actualChatUsage` 一起导出给私有计费套件：它拿真实账本验这套折算端到端对得上。
 */
export function reservedChatUsage(
  estimatedInputTokens: number,
  pricing: ChatTaskPricing,
): TaskUsage {
  return usageUnits(estimatedInputTokens, pricing.outputReserveTokens, pricing)
}

export function actualChatUsage(usage: AgentTurnUsage, pricing: ChatTaskPricing): TaskUsage {
  return {
    ...usageUnits(usage.inputTokens, usage.outputTokens, pricing, usage.cachedInputTokens),
    tokens: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      ...(usage.cachedInputTokens ? { cachedInput: usage.cachedInputTokens } : {}),
    },
  }
}

/**
 * 积分占用挂在 task_id 上，而私有账本对 tasks 有外键，所以对话轮必须先有一条自己的任务行。
 * 状态直接进 in_progress：worker 只 claim `queued`，这一行它永远捞不走。
 */
async function insertChatTask(
  tx: BffTransaction,
  input: {
    taskId: string
    conversationId: string
    userId: string
    deviceId: string
    model: string
  },
): Promise<void> {
  const now = Date.now()
  await tx.insert(schema.tasks).values({
    id: input.taskId,
    kind: 'chat',
    provider: 'openai-compat',
    model: input.model,
    status: 'in_progress',
    // 会话内容不进后台，占位里只留设备号——它喂的是 device_id 那个生成列。
    request_payload: { prompt: '', device_id: input.deviceId },
    submitted_at: now,
    started_at: now,
    user_id: input.userId,
    agent_conversation_id: input.conversationId,
    agent_turn_id: input.taskId,
    execution_token: agentExecutionToken(input.taskId),
    lease_expires_at: now + AGENT_EXECUTION_LEASE_MS,
  })
}

/** 工具任务各自独立计费，只用轮 id 关联，所以本轮的账要从任务表反查再归集。 */
async function collectTurnCost(conversationId: string, turnId: string): Promise<AgentTurnCost> {
  const rows = await db
    .select({
      id: schema.tasks.id,
      kind: schema.tasks.kind,
      video: sql<string | null>`${schema.tasks.request_payload} ->> 'video'`,
    })
    .from(schema.tasks)
    .where(
      and(
        // 前导列不给全就用不上 idx_tasks_agent_turn，退化成全表扫。
        eq(schema.tasks.agent_conversation_id, conversationId),
        eq(schema.tasks.agent_turn_id, turnId),
      ),
    )
  const overlay = await loadPrivateBffOverlay()
  const credits = await overlay.taskHooks.taskCredits({ taskIds: rows.map((row) => row.id) })

  const cost = { chat: 0, image: 0, video: 0 }
  for (const row of rows) {
    const bucket = row.kind === 'chat' ? 'chat' : row.video ? 'video' : 'image'
    cost[bucket] += credits[row.id] ?? 0
  }
  return cost
}

/** 结算是模块级工厂而不是用例里的闭包：闭包会把整段历史钉到轮结束。 */
function chatTaskSettle(
  conversationId: string,
  turnId: string,
  pricing: ChatTaskPricing,
): ChatTaskSettle {
  return async (settlement: AgentTurnSettlement): Promise<AgentTurnCost> => {
    const finished = await executionContext.run(agentExecutionToken(turnId), () =>
      finishTask(turnId, {
        status: settlement.outcome,
        completedAt: Date.now(),
        upstreamInvocationCount: settlement.upstreamInvocationCount,
        // usage 为 null 是上游没报，缺席即按预留全额结算——退错方向就是凭空造积分。
        ...(settlement.usage ? { actualUsage: actualChatUsage(settlement.usage, pricing) } : {}),
      }),
    )
    if (!finished) {
      const [task] = await db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, turnId))
        .limit(1)
      // finishTask and the private ledger commit atomically. A retry after the commit may observe
      // the terminal row even when the following cost read was interrupted.
      if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) {
        throw new Error('Chat task settlement lost its execution lease')
      }
    }
    return collectTurnCost(conversationId, turnId)
  }
}

/**
 * 在调用方的事务里落下这一轮的对话任务并预扣积分。预扣成功时连带交出收尾结算；
 * 被拒时任务行原地清掉，调用方照常把拒绝形状回给上面。
 */
export async function reserveChatTask(input: ReserveChatTaskInput): Promise<ChatTaskReservation> {
  const { tx, taskHooks, conversationId, turnId, userId, deviceId, model, pricing } = input
  await insertChatTask(tx, { taskId: turnId, conversationId, userId, deviceId, model })
  const reserved = await taskHooks.reserveTask({
    tx,
    taskId: turnId,
    userId,
    model,
    ...reservedChatUsage(input.estimatedInputTokens, pricing),
  })
  if (reserved.kind !== 'reserved') {
    // 余额不足的轮压根没发生过，别把这条任务行留给恢复扫描去收尸。
    await tx.delete(schema.tasks).where(eq(schema.tasks.id, turnId))
    return reserved
  }
  return {
    kind: 'reserved',
    reservedCredits: reserved.credits,
    settle: chatTaskSettle(conversationId, turnId, pricing),
  }
}
