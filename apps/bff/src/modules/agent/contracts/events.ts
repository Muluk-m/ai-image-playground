import type {
  AgentToolResultBlock,
  AgentToolStartEvent,
  AgentTurnEvent,
} from '@image-playground/shared'

/**
 * 补写终帧时跳过的序号。被打断的轮在内存里发过、还没落库的尾巴客户端可能已经收到了，
 * 表里的最大序号并不是客户端见过的最大序号；紧挨着它发号，终帧就会和那段尾巴撞号，
 * 带着 `Last-Event-ID` 续播的客户端会把它当成见过的跳过去，永远收不到结局。
 * 攒批窗口里的事件远到不了这个数，跳过之后序号留一个空档，但不会重号。
 */
export const SEAL_SEQ_GAP = 10_000

/** 补写终帧时领会话租约用的轮标识前缀。它不是一轮：起轮撞上它该等一等，而不是转去续播。 */
export const SEAL_LEASE_PREFIX = 'seal:'

export function isSealLease(turnId: string): boolean {
  return turnId.startsWith(SEAL_LEASE_PREFIX)
}

export interface StoredAgentEvent {
  readonly seq: number
  readonly event: AgentTurnEvent
}

/**
 * 一轮的写入把手。序号由日志自己发，攒批落库也由它自己做；调用方只管 `emit`。
 */
export interface TurnEventLog {
  /** 开日志时会话已有的最大序号；本轮第一条事件是它加一。 */
  readonly baseSeq: number
  emit(event: AgentTurnEvent): void
  /** 终帧发过没有。发过之后这份日志只剩落库与收流，不再收会话级的通知。 */
  readonly ended: boolean
  /** 本轮跑着时的实时流；断开重开都从给定断点续。 */
  read(afterSeq: number): AsyncGenerator<StoredAgentEvent>
  /** 把攒着的事件写完。 */
  flush(): Promise<void>
  /** 收流前必须先 flush，否则消费者会先于落库看到轮结束、重连读到半截。 */
  close(): void
}

/**
 * 读一轮事件的判别结果：在跑的轮给实时流，跑完的轮给表里的重放，
 * 从没有过事件的轮才是「没这一轮」。
 */
export type TurnEventFeed =
  | { readonly kind: 'live'; readonly events: AsyncGenerator<StoredAgentEvent> }
  | { readonly kind: 'replay'; readonly events: readonly StoredAgentEvent[] }
  | { readonly kind: 'no-such-turn' }

/** 这次调用从起到止一直带着的东西：结果卡的标题与提示词由起跑那一刻定下，不再重算。 */
export type AgentToolStart = Omit<AgentToolStartEvent, 'type' | 'messageId'>

export interface AgentToolOutcome {
  /** 下发与落库的同一个结果块。 */
  readonly block: AgentToolResultBlock
  /** 这次失败要不要把整轮停下。 */
  readonly abortsTurn: boolean
}
