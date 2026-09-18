import type { AgentMode, AgentTurnReference } from '@image-playground/shared'
import type { StoredAgentEvent } from './events'

/**
 * 一轮在 API 进程里的把手。轮独立于连接存活，只有跑完、失败或显式中止才结束。
 * 注册表是进程内的：BFF 多副本时续播会落到没有这一轮的进程上。
 */
export interface RunningTurn {
  readonly conversationId: string
  readonly turnId: string
  /** 这一轮按什么装配的。插话要照同一份技能清单展开 `/skill-name`，所以它得挂在轮上。 */
  readonly mode: AgentMode
  readonly completed?: Promise<void>
  read(afterSeq: number): AsyncGenerator<StoredAgentEvent>
  /**
   * 返回插话那条用户消息的 id；它也随 `interjection` 事件发给所有连着的消费者。
   * `messageId` 缺席即新起一个；排队消息升级来的插话沿用收件箱记录的 id。
   */
  interject(
    text: string,
    references?: readonly AgentTurnReference[],
    messageId?: string,
  ): Promise<string | null>
  abort(): void
}

const running = new Map<string, RunningTurn>()

/** 一个会话同时只允许一轮，起第二轮的请求由路由挡在门口。 */
export function runningTurn(conversationId: string): RunningTurn | undefined {
  return running.get(conversationId)
}

export function registerRunningTurn(turn: RunningTurn): () => void {
  running.set(turn.conversationId, turn)
  return () => {
    if (running.get(turn.conversationId) === turn) running.delete(turn.conversationId)
  }
}
