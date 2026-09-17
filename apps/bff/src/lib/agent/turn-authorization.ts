import type { AgentMessageView } from '@image-playground/shared'
import { agentClarificationSummary } from '@image-playground/shared'
import type { AgentImageReference } from './images'
import { replayTurnText, turnPromptText } from './turn-input'

/**
 * 「这一轮用户授权了什么」只由本模块回答。它与 `turn-input.ts` 走同一段历史，读法却不同：
 * 送给模型的输入回放整段对话，授权只认末尾那条未完成的澄清链——已完成的任务模型仍读得到，
 * 但不是本轮的许可。
 *
 * 这段文字会被拿去校验 requestQuote 是不是原文的子串（`masked-plan.ts` 与 `masked-edit.ts`），
 * 差一个字符就会把本该放行的改图拒掉，所以每一个分隔符都定在这一处。
 */

/** 未完成澄清链的起点：从历史末尾往回走，澄清与作答它的那条用户消息都还算本轮。 */
function clarificationChainStart(history: readonly AgentMessageView[]): number {
  let start = history.length
  while (start > 0) {
    const tail = history.slice(0, start)
    const last = tail[tail.length - 1]!
    if (!last.content.some((block) => block.type === 'clarification')) break
    let userIndex = tail.length - 2
    while (userIndex >= 0 && tail[userIndex]!.role !== 'user') userIndex--
    if (userIndex < 0) break
    start = userIndex
  }
  return start
}

/**
 * 起轮那一刻的授权原文：未完成澄清链上的用户原话与澄清摘要逐条排开，
 * 收尾是本轮 prompt 与它的引用清单。助手自己说的话不是授权，不进来。
 */
export function turnAuthorizationText(
  history: readonly AgentMessageView[],
  prompt: string,
  references: readonly AgentImageReference[],
): string {
  return [
    ...history
      .slice(clarificationChainStart(history))
      .flatMap((message) =>
        message.role === 'user'
          ? [replayTurnText(message)]
          : message.content.flatMap((block) =>
              block.type === 'clarification' ? [agentClarificationSummary(block)] : [],
            ),
      ),
    turnPromptText(prompt, references),
  ].join('\n')
}

/** 当前版本的授权原文。对象身份就是版本身份：工具取了快照，靠 `!==` 认出原文被改过。 */
export interface TurnAuthorizationText {
  readonly revision: number
  readonly instructions: string
}

export interface TurnAuthorization {
  /** 此刻的授权原文；同一版本每次拿到的是同一个对象。 */
  current(): TurnAuthorizationText
  /** 用户插话：那句原话连同它的引用清单追加成「用户补充」，版本加一。 */
  amend(text: string, references: readonly AgentImageReference[]): void
}

/** 一轮授权原文的完整生命：起轮时定下来，之后只被插话追加。 */
export function createTurnAuthorization(input: {
  readonly history: readonly AgentMessageView[]
  readonly prompt: string
  readonly references: readonly AgentImageReference[]
}): TurnAuthorization {
  let authorized: TurnAuthorizationText = {
    revision: 0,
    instructions: turnAuthorizationText(input.history, input.prompt, input.references),
  }
  return {
    current: () => authorized,
    amend(text, references) {
      authorized = {
        revision: authorized.revision + 1,
        instructions: `${authorized.instructions}\n用户补充：${turnPromptText(text, references)}`,
      }
    },
  }
}
