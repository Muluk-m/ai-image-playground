import type { AgentPanelMessage, AgentTurnFooter, AgentTurnStatus } from '../types'
import { conversationCache } from './conversationCache'

/** 写本机历史快照只看面板上的这几项。 */
export interface HistoryCacheView {
  readonly conversationId: string | null
  readonly messages: AgentPanelMessage[]
  readonly turns: Record<string, AgentTurnFooter>
  readonly turn: AgentTurnStatus
  readonly historyCached: boolean
  readonly historyLoading: boolean
  readonly historyFailed: boolean
}

export type HistoryCacheHandle = Pick<
  ReturnType<typeof conversationCache>,
  'isCurrent' | 'write' | 'remove'
>

export interface HistoryCacheWriterDeps {
  readonly openCache?: (conversationId: string) => HistoryCacheHandle
  /** 一轮在跑时的合并窗口；流式输出不必每个字都落盘。 */
  readonly runningDelayMs?: number
}

export interface HistoryCacheWriter {
  /** 接在 store.subscribe 上：会话变了换目标，面板变了排一次写。 */
  observe(state: HistoryCacheView, previous: HistoryCacheView): void
  /** 把排着的那次写立刻落下（换会话、离开页面前）。 */
  flush(): void
  /** 读服务端历史前改认这个会话为写入目标，返回它的句柄。 */
  bind<H extends HistoryCacheHandle>(handle: H): H
  /** 会话已不存在：先落下排着的写，再删掉它的快照。 */
  forget(conversationId: string): Promise<void>
}

/**
 * 面板的本机显示快照。只在面板展示的是服务端已确认的历史时写（不是缓存预览、不在读取中、
 * 没读失败），本机还没上轮的用户气泡不写，流式中的文本按已结束存，免得下次打开时转个不停。
 */
export function createHistoryCacheWriter(deps: HistoryCacheWriterDeps = {}): HistoryCacheWriter {
  const openCache = deps.openCache ?? ((conversationId) => conversationCache(conversationId))
  const runningDelayMs = deps.runningDelayMs ?? 500
  let cache: HistoryCacheHandle | null = null
  let pending: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    pending?.()
    pending = undefined
  }

  return {
    observe(state, previous) {
      if (state.conversationId !== previous.conversationId) {
        flush()
        cache = state.conversationId ? openCache(state.conversationId) : null
        return
      }
      if (
        !state.messages.length ||
        !cache?.isCurrent() ||
        state.historyCached ||
        state.historyLoading ||
        state.historyFailed ||
        (state.messages === previous.messages && state.turns === previous.turns)
      )
        return
      const owner = cache
      pending = () => {
        void owner.write({
          messages: state.messages
            .filter((message) => message.kind !== 'text' || !message.pending)
            .map((message) =>
              message.kind === 'text' ? { ...message, streaming: false } : message,
            ),
          turns: state.turns,
        })
      }
      if (state.turn === 'running') {
        if (!timer)
          timer = setTimeout(() => {
            timer = undefined
            flush()
          }, runningDelayMs)
      } else flush()
    },
    flush,
    bind(handle) {
      flush()
      cache = handle
      return handle
    },
    async forget(conversationId) {
      flush()
      await openCache(conversationId).remove()
    },
  }
}
