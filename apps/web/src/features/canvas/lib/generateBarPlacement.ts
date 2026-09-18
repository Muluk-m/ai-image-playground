export interface ChatSnapshot {
  /** 智能体已开始读当前项目的会话；读之前看到的「空」不作数。 */
  readonly loaded: boolean
  readonly messageCount: number
  readonly historyLoading: boolean
  /** 历史没读出来时对话其实可能有内容，不能当成空对话。 */
  readonly historyFailed: boolean
}

/**
 * 有智能体时，生成栏只在当前对话确实为空（已读完、没有任何消息、历史既不在加载也没读失败）时
 * 浮在画布底部——发出第一条消息就收起，切到新的空对话再出现。没有智能体的部署仍用侧栏里的生成栏。
 */
export function floatGenerateBar(hasAgent: boolean, chat: ChatSnapshot): boolean {
  return (
    hasAgent &&
    chat.loaded &&
    chat.messageCount === 0 &&
    !chat.historyLoading &&
    !chat.historyFailed
  )
}
