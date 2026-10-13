import type { AgentPanelMessage, AgentTurnFooter } from '../types'
import { fetchFollowUps } from './agentClient'
import { answerableClarificationId } from './panelMessages'

const EMPTY: readonly string[] = []
const ATTEMPTS = 10
const INTERVAL_MS = 2_000

type FollowUpReader = (conversationId: string, turnId: string) => Promise<readonly string[] | null>

let readerForTests: FollowUpReader | null = null

/** 用例替换轮询的读取。传 null 恢复默认。 */
export function setFollowUpReaderForTesting(reader: FollowUpReader | null): void {
  readerForTests = reader
}

function currentReader(): FollowUpReader {
  if (readerForTests) return readerForTests
  // 现有用例用全局 fetch 冒充别的接口。测试里默认不发这次旁路请求，要断言结果的用例自己装 reader。
  if (import.meta.env.MODE === 'test') return async () => []
  return fetchFollowUps
}

/** 末尾这一轮已经正常说完，而且没有还等着用户回答的澄清或确认卡。 */
export function shouldPollFollowUps(input: {
  readonly turnId: string
  readonly messages: readonly AgentPanelMessage[]
  readonly turns: Readonly<Record<string, AgentTurnFooter>>
}): boolean {
  return readyTurn(input.messages, input.turns) === input.turnId
}

/**
 * 输入框上方要显示的句子。正在跑、历史没就绪、欢迎页、输入框里已经有字，都不显示。
 * 返回的空数组是稳定引用，避免订阅每次都拿到新数组。
 */
export function visibleFollowUps(input: {
  readonly idle: boolean
  readonly historyBlocked: boolean
  readonly welcome: boolean
  readonly draft: string
  readonly messages: readonly AgentPanelMessage[]
  readonly turns: Readonly<Record<string, AgentTurnFooter>>
}): readonly string[] {
  if (!input.idle || input.historyBlocked || input.welcome || input.draft.trim()) return EMPTY
  const turnId = readyTurn(input.messages, input.turns)
  if (!turnId) return EMPTY
  const lines = input.turns[turnId]?.followUps
  return lines?.length ? lines : EMPTY
}

function readyTurn(
  messages: readonly AgentPanelMessage[],
  turns: Readonly<Record<string, AgentTurnFooter>>,
): string | null {
  const last = messages[messages.length - 1]
  if (!last) return null
  if (answerableClarificationId(messages)) return null
  if (
    messages.some(
      (message) =>
        message.turnId === last.turnId &&
        message.kind === 'tool' &&
        message.status === 'awaiting_confirmation',
    )
  )
    return null
  const footer = turns[last.turnId]
  if (!footer || footer.stopReason !== 'completed' || footer.error) return null
  return last.turnId
}

/**
 * 终帧之后问几次。null 是还在生成，空数组是已经没有可显示的。
 * 问满或中途不该再问，就停。
 */
export async function pollFollowUps(
  conversationId: string,
  turnId: string,
  still: () => boolean,
  read: FollowUpReader = currentReader(),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<readonly string[] | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(INTERVAL_MS)
    if (!still()) return null
    try {
      const lines = await read(conversationId, turnId)
      if (!still()) return null
      if (lines === null) continue
      return lines.length > 0 ? lines : null
    } catch {
      // 这一拍没问到，下一拍再试。问满了就当这次没赶上，刷新后仍能从历史里读到。
    }
  }
  return null
}
