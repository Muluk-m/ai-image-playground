/** 画布生成栏放在哪：侧栏（没有智能体）、画布底部浮层（智能体的当前对话为空）、不出现。 */
export type GenerateBarPlacement = 'sidebar' | 'floating' | 'hidden'

export interface ChatSnapshot {
  readonly messageCount: number
  readonly historyLoading: boolean
}

/**
 * 没有智能体的部署一直用侧栏里的生成栏；有智能体时，只在当前对话还没有任何消息、
 * 历史也不在加载中时浮在画布底部——发出第一条消息就收起，切到新的空对话再出现。
 */
export function generateBarPlacement(hasAgent: boolean, chat: ChatSnapshot): GenerateBarPlacement {
  if (!hasAgent) return 'sidebar'
  return chat.messageCount === 0 && !chat.historyLoading ? 'floating' : 'hidden'
}
