/**
 * 面板上「历史有没有读回来」的显式视图。
 * store 仍把 `historyCached`、`historyLoading`、`historyFailed` 分开放；
 * 加载中的失败位以 loading 为准（和 AgentHistoryStatus 原来的判断顺序一致）。
 * 空闲时不带 cached：成功拉完远端后 store 会把 cached 清掉，状态条也不读它。
 * 写入点还没收成一个 reducer。
 * 不要把本函数的返回值直接当作 useAgentStore 的 selector 结果：每次都是新对象，
 * React 会当成订阅值一直在变，面板更新会跑爆。先读三个布尔，再在组件里调用。
 */
export type AgentHistorySession =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading'; readonly cached: boolean }
  | { readonly phase: 'failed'; readonly cached: boolean }

export function agentHistorySession(input: {
  readonly historyCached: boolean
  readonly historyLoading: boolean
  readonly historyFailed: boolean
}): AgentHistorySession {
  if (input.historyLoading) return { phase: 'loading', cached: input.historyCached }
  if (input.historyFailed) return { phase: 'failed', cached: input.historyCached }
  return { phase: 'idle' }
}

export function historyBlocksComposer(session: AgentHistorySession): boolean {
  return session.phase !== 'idle'
}
