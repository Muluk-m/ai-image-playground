import type {
  AgentActiveTurnView,
  AgentClarificationBlock,
  AgentContentBlock,
  AgentMessageRole,
  AgentMessageView,
  AgentToolResultBlock,
  AgentToolStartEvent,
  AgentTurnEvent,
  AgentTurnSummaryView,
} from '@image-playground/shared'
import { agentTextFromBlocks, isAgentToolErrorCode } from '@image-playground/shared'
import type {
  AgentClarificationMessage,
  AgentPanelMessage,
  AgentTextMessage,
  AgentToolMessage,
  AgentTurnFooter,
  AgentTurnStatus,
} from '../types'

/**
 * 面板里「消息长什么样」的唯一权威：翻历史与看直播都从这里拿。
 *
 * 纯函数，不认识 store、交付、i18n 与网络。服务端一份块既发成事件又落进库，
 * 所以这两条路最终都落到同一个 {@link panelMessage} 上——新增一种块只改这里一处。
 */
export interface AgentPanelState {
  readonly messages: AgentPanelMessage[]
  readonly turns: Record<string, AgentTurnFooter>
}

/** `GET .../messages` 里面板要的那两项。 */
export interface AgentPanelHistory {
  readonly messages: readonly AgentMessageView[]
  readonly turns: readonly AgentTurnSummaryView[]
}

export interface AgentPanelEventContext {
  /** 这一轮的标识。`turnStart` 之前到的事件也挂在它下面。 */
  readonly turnId: string
  /** 敲下回车那句话：`turnStart` 用它补上服务端那条用户消息的正文。 */
  readonly pendingUserText: string | null
}

function toolCard(block: AgentToolResultBlock, id: string, turnId: string): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId,
    toolCallId: block.toolCallId,
    toolName: block.toolName,
    title: block.title,
    ...(block.prompt ? { prompt: block.prompt } : {}),
    status: block.status,
    ...(block.artifacts ? { artifacts: block.artifacts } : {}),
    ...(block.anchorObjectId ? { anchorObjectId: block.anchorObjectId } : {}),
    ...(block.skill ? { skill: block.skill } : {}),
    ...(block.message ? { message: block.message } : {}),
    // 认不出的码（更新的服务端）当没有码：界面退回旧样子，而不是给一个不存在的出路。
    ...(isAgentToolErrorCode(block.errorCode) ? { errorCode: block.errorCode } : {}),
  }
}

function clarificationCard(
  block: AgentClarificationBlock,
  id: string,
  turnId: string,
): AgentClarificationMessage {
  return { kind: 'clarification', id, turnId, question: block.question, options: block.options }
}

function textCard(
  id: string,
  turnId: string,
  role: AgentMessageRole,
  text: string,
): AgentTextMessage {
  return { kind: 'text', id, turnId, role, text, streaming: false }
}

/**
 * 一条消息的全部构造规则。入参就是这条消息落库的样子：id、轮、角色、内容块。
 * 一条助手消息只装一个块（工具结果、澄清、或纯文字），判别顺序与后端落库一致。
 */
export function panelMessage(
  id: string,
  turnId: string,
  role: AgentMessageRole,
  content: readonly AgentContentBlock[],
): AgentPanelMessage {
  const result = content.find((block): block is AgentToolResultBlock => block.type === 'toolResult')
  if (result) return toolCard(result, id, turnId)
  const asked = content.find(
    (block): block is AgentClarificationBlock => block.type === 'clarification',
  )
  if (asked) return clarificationCard(asked, id, turnId)
  return textCard(id, turnId, role, agentTextFromBlocks(content))
}

function historyMessage(message: AgentMessageView): AgentPanelMessage {
  return panelMessage(message.id, message.turnId, message.role, message.content)
}

/** 读回来的一段会话：消息与每轮页脚。 */
export function panelStateFromHistory(history: AgentPanelHistory): AgentPanelState {
  return {
    messages: history.messages.map(historyMessage),
    turns: Object.fromEntries(history.turns.map((one) => [one.turnId, one])),
  }
}

/**
 * 半截的东西撤掉：还在流的回复，以及起轮前就失败的那条先上屏的用户消息——草稿还在输入框里，
 * 留着它屏幕上就有两份同样的话。
 */
export function dropUnsettledMessages(messages: readonly AgentPanelMessage[]): AgentPanelMessage[] {
  return messages.filter((one) => one.kind !== 'text' || (!one.streaming && !one.pending))
}

function mergeTurn(
  turns: Record<string, AgentTurnFooter>,
  turnId: string,
  patch: Partial<AgentTurnFooter>,
): Record<string, AgentTurnFooter> {
  return { ...turns, [turnId]: { ...turns[turnId], turnId, ...patch } }
}

function replaceOrAppend(
  messages: readonly AgentPanelMessage[],
  message: AgentPanelMessage,
): AgentPanelMessage[] {
  const index = messages.findIndex((one) => one.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((one, at) => (at === index ? message : one))
}

/** 工具起跑那一刻的卡：还没有结果块，所以它是直播独有的形状，定稿时被 `toolEnd` 整条换掉。 */
function runningToolCard(event: AgentToolStartEvent, turnId: string): AgentToolMessage {
  return {
    kind: 'tool',
    id: event.messageId,
    turnId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    title: event.title,
    ...(event.prompt ? { prompt: event.prompt } : {}),
    status: 'running',
    ...(event.anchorObjectId ? { anchorObjectId: event.anchorObjectId } : {}),
  }
}

/**
 * 本轮此前那段助手文字说完了，把它定稿。线协议里没有「说完了」这个事件，所以拿后续事件当边界：
 * 后端 `toolExecution: 'sequential'`，pi 的 `message_end` 一定先于工具起跑，收到 `toolStart`、
 * `clarification` 或下一条 `assistantStart` 时，此前那段话在服务端已经落库。定了稿，这一轮再失败
 * 也不会被 {@link dropUnsettledMessages} 当半截撤掉——撤掉它直播与刷新就不是同一个面板。
 *
 * 插话不是边界：`turn.ts` 的 `interject` 在助手消息还开着时就发事件（那条用户消息进 `queued`，
 * 等 `message_end` 才落库），事件之后同一条文字还会来增量。
 *
 * 一个字都没有的那张卡不定稿：服务端不为它落库，失败时照旧撤掉。
 */
function settleOpenReplies(
  messages: readonly AgentPanelMessage[],
  turnId: string,
): AgentPanelMessage[] {
  return messages.map((one) =>
    one.kind === 'text' &&
    one.role === 'assistant' &&
    one.streaming &&
    one.text !== '' &&
    one.turnId === turnId
      ? { ...one, streaming: false }
      : one,
  )
}

/**
 * 一个事件归约进面板。事件按 id 幂等：重连重发的帧、以及续播重放的整轮，都落到同一个结果上。
 *
 * 凡是「这个块已经定稿」的时点（`toolEnd`、澄清、插话）都走 {@link panelMessage}，与历史同源；
 * 直播独有的只剩 `streaming`、增量累加、待确认 id 的替换与 `toolProgress` 的 stage——
 * 它们是对同一形状的增量修改。轮的状态（running / failed）不归这里，归 store。
 */
export function reduceAgentPanelEvent(
  state: AgentPanelState,
  event: AgentTurnEvent,
  context: AgentPanelEventContext,
): AgentPanelState {
  const { turnId, pendingUserText } = context
  switch (event.type) {
    case 'turnStart':
      return {
        turns: mergeTurn(
          state.turns,
          event.turnId,
          event.reservedCredits === undefined ? {} : { reservedCredits: event.reservedCredits },
        ),
        // 续播没有正文可补（`pendingUserText` 为空），找不到那条用户消息就不显示它：
        // 空气泡比少一条更糟。
        messages:
          pendingUserText === null || state.messages.some((one) => one.id === event.userMessageId)
            ? state.messages
            : [
                // 先上屏的那条换成服务端的 id；同一轮不会有第二条待确认的。
                ...state.messages.filter((one) => one.kind !== 'text' || !one.pending),
                panelMessage(event.userMessageId, turnId, 'user', [
                  { type: 'text', text: pendingUserText },
                ]),
              ],
      }
    case 'assistantStart':
      // 先定稿再替换：重放同一条 `assistantStart` 时，替换会原样还它 `streaming: true`。
      return {
        ...state,
        messages: replaceOrAppend(settleOpenReplies(state.messages, turnId), {
          ...textCard(event.messageId, turnId, 'assistant', ''),
          streaming: true,
        }),
      }
    case 'interjection':
      return {
        ...state,
        messages: replaceOrAppend(
          state.messages,
          panelMessage(event.messageId, turnId, 'user', [{ type: 'text', text: event.text }]),
        ),
      }
    case 'textDelta':
      return {
        ...state,
        messages: state.messages.map((one) =>
          one.kind === 'text' && one.id === event.messageId
            ? { ...one, text: one.text + event.delta }
            : one,
        ),
      }
    case 'toolStart':
      return {
        ...state,
        messages: replaceOrAppend(
          settleOpenReplies(state.messages, turnId),
          runningToolCard(event, turnId),
        ),
      }
    case 'toolProgress':
      return {
        ...state,
        messages: state.messages.map((one) =>
          one.kind === 'tool' && one.id === event.messageId ? { ...one, stage: event.stage } : one,
        ),
      }
    case 'clarification': {
      const { messageId, ...block } = event
      return {
        ...state,
        messages: replaceOrAppend(
          settleOpenReplies(state.messages, turnId),
          panelMessage(messageId, turnId, 'assistant', [block]),
        ),
      }
    }
    case 'toolEnd': {
      const { type: _event, messageId, ...block } = event
      return {
        ...state,
        messages: replaceOrAppend(
          state.messages,
          panelMessage(messageId, turnId, 'assistant', [{ ...block, type: 'toolResult' }]),
        ),
      }
    }
    case 'turnEnd': {
      const turns = mergeTurn(state.turns, event.turnId, {
        durationMs: event.durationMs,
        stopReason: event.stopReason,
        ...(event.cost ? { cost: event.cost } : {}),
      })
      // 失败的轮不留半截内容；轮状态与错误文案由 store 收口。
      if (event.stopReason === 'failed')
        return { turns, messages: dropUnsettledMessages(state.messages) }
      return {
        turns,
        messages: state.messages.map((one) =>
          one.kind === 'text' && one.streaming ? { ...one, streaming: false } : one,
        ),
      }
    }
  }
}

/**
 * 可作答的只有末尾那一条：澄清之后一旦有用户消息，它就已经作过答。
 * 回填的答案本身就是那条用户消息，所以不必另存作答状态。
 */
export function answerableClarificationId(messages: readonly AgentPanelMessage[]): string | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!
    if (message.kind === 'text' && message.role === 'user') return null
    if (message.kind === 'clarification') return message.id
  }
  return null
}

/**
 * 这个会话有没有"开始"：敲下回车那条先上屏的消息也算。欢迎页据此让位——
 * 发送是乐观的，视图不等服务端确认；起轮失败会把那条撤回，欢迎页随之回来。
 */
export function conversationStarted(messages: readonly AgentPanelMessage[]): boolean {
  return messages.length > 0
}

export type AgentActivityPhase = 'sending' | 'thinking' | 'executing' | 'stopping'

/** 状态行要看的那几项，取自 store 的同名字段。 */
export interface AgentActivityView {
  readonly turn: AgentTurnStatus
  readonly activeTurn: AgentActiveTurnView | null
  readonly messages: readonly AgentPanelMessage[]
  readonly stopping?: boolean
}

/**
 * 进行中这一轮此刻在干什么，给对话末尾的状态行用。文字一旦在流就返回 null：
 * 正文自己就是最好的进度。
 */
export function agentActivityPhase(state: AgentActivityView): AgentActivityPhase | null {
  if (state.turn !== 'running') return null
  if (state.stopping) return 'stopping'
  if (!state.activeTurn) return 'sending'
  const last = state.messages[state.messages.length - 1]
  if (last?.kind === 'tool' && last.status === 'running') return 'executing'
  if (last?.kind === 'text' && last.role === 'assistant' && last.streaming && last.text) return null
  return 'thinking'
}
