import type { AgentMode, AgentTurnReference } from '@image-playground/shared'
import type { StoredAgentEvent } from './events'

export interface AgentInterjectOptions {
  /** 缺席即新起一个；排队消息升级来的插话沿用收件箱记录的 id。 */
  readonly messageId?: string
  /**
   * 插话进这一轮之前的最后一步：参考图校验与归档都过了、就要写进这一轮时调用。返回 false
   * 就不插（清掉本次归档）。排队消息升级为插话时，在这里才从收件箱取走它。
   */
  readonly claim?: () => Promise<boolean>
}

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
   * 返回插话那条用户消息的 id；它也随 `interjection` 事件发给所有连着的消费者。插不进去
   * （本轮已收尾、被中止，或 `claim` 没取到）返回 null。
   */
  interject(
    text: string,
    references?: readonly AgentTurnReference[],
    options?: AgentInterjectOptions,
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
