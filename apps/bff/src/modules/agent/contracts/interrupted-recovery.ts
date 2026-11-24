import type { AgentInboxResumePayload } from '@image-playground/db'
import type { AgentToolEndEvent } from '@image-playground/shared'

export interface InterruptedTurnRecovery {
  /** 补写的结果卡，排在终帧之前发给续播的客户端。 */
  readonly events: readonly AgentToolEndEvent[]
  /** 要续跑时的载荷；不续（续跑那一轮自己被打断、在等澄清答复、不是收件箱起的轮）为 null。 */
  readonly resume: AgentInboxResumePayload | null
}

export type InterruptedTurnRecoverer = (
  conversationId: string,
  turnId: string,
) => Promise<InterruptedTurnRecovery | null>

let defaultRecoverer: InterruptedTurnRecoverer | null = null

/** 组合根注册中断轮恢复实现，避免 `runtime/stream-broker` 静态或动态依赖 `lib/agent/interrupted`。 */
export function registerInterruptedTurnRecoverer(recoverer: InterruptedTurnRecoverer): void {
  defaultRecoverer = recoverer
}

export function getInterruptedTurnRecoverer(): InterruptedTurnRecoverer | null {
  return defaultRecoverer
}
