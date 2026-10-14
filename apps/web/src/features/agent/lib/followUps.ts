import type { AgentPanelMessage, AgentTurnFooter } from '../types'
import { fetchFollowUps } from './agentClient'
import { answerableClarificationId } from './panelMessages'

const EMPTY: readonly string[] = []
/**
 * 第一拍马上问，之后按这张表退避，间隔加起来 45 秒。
 * 后端单次最多 30 秒，超时还会再问一次；45 秒盖住「第一次用满、第二次较快答上」。
 * 两次都拖满约 60 秒时，这次界面不再等，句子仍会落库，刷新后从历史里读到。
 */
const POLL_BACKOFF_MS = [2_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 8_000]

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
 * 可以显示的下一句。正在跑、历史没就绪、欢迎页、输入框里已经有字，都不显示。
 * 界面把第一句当成用户最可能打的下一句，画成输入框里的灰色幽灵文字。
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
 * 空输入框上的幽灵文字怎么响应按键。Tab，以及光标已在末尾时的右方向键，把句子填进输入框。
 * Esc 只关掉这一次，不发送。带修饰键或正在组字时不拦截。
 */
export function followUpGhostAction(
  event: {
    readonly key: string
    readonly shiftKey: boolean
    readonly altKey: boolean
    readonly ctrlKey: boolean
    readonly metaKey: boolean
    readonly isComposing: boolean
  },
  caretAtEnd: boolean,
): 'accept' | 'dismiss' | null {
  if (event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return null
  }
  if (event.key === 'Escape') return 'dismiss'
  if (event.key === 'Tab' || (event.key === 'ArrowRight' && caretAtEnd)) return 'accept'
  return null
}

/**
 * 终帧之后问到大约 45 秒。读到 null 是还在生成，继续等。
 * 读到空数组是已经定了（失败，或没有可用的句子），立刻停，别把失败当成还在等。
 * 问满或中途不该再问，就停。
 */
export async function pollFollowUps(
  conversationId: string,
  turnId: string,
  still: () => boolean,
  read: FollowUpReader = currentReader(),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<readonly string[] | null> {
  for (let attempt = 0; attempt < POLL_BACKOFF_MS.length + 1; attempt += 1) {
    if (attempt > 0) await wait(POLL_BACKOFF_MS[attempt - 1] ?? 0)
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
