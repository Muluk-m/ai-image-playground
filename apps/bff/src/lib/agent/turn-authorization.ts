import type { AgentMessageView } from '@image-playground/shared'
import { agentClarificationSummary } from '@image-playground/shared'
import type {
  AgentImageReference,
  TurnAuthorization,
  TurnAuthorizationText,
} from '../../modules/agent/contracts'
import { clarificationChainStart, replayTurnText, turnPromptText } from './turn-input'

export type { TurnAuthorization, TurnAuthorizationText }

/**
 * 「这一轮用户授权了什么」只由本模块回答：与 `turn-input.ts` 同一段历史，但只认末尾那条
 * 未完成的澄清链。这段文字要拿去校验 requestQuote 是不是它的子串（`masked-plan.ts` 与
 * `masked-edit.ts`），差一个字符就会把本该放行的改图拒掉，所以每一个分隔符都定在这一处。
 */

/**
 * 起轮那一刻的授权原文：澄清链上的用户原话与澄清摘要，收尾是本轮 prompt 与引用清单。
 * `attached` 与送给模型的那一份同源：清单措辞两边差一个字，requestQuote 的子串校验就会失手。
 */
export function turnAuthorizationText(
  history: readonly AgentMessageView[],
  prompt: string,
  references: readonly AgentImageReference[],
  attached: boolean,
): string {
  return [
    ...history
      .slice(clarificationChainStart(history))
      .flatMap((message) =>
        message.role === 'user'
          ? [replayTurnText(message, 'retained')]
          : message.content.flatMap((block) =>
              block.type === 'clarification' ? [agentClarificationSummary(block)] : [],
            ),
      ),
    turnPromptText(prompt, references, attached),
  ].join('\n')
}

/**
 * 一轮授权原文的完整生命：起轮时定下来，之后只被插话追加。唤醒轮没有用户原话，带着提交那一批时
 * 记下的原文（`carried`）起，原样沿用，不再按历史重拼。
 */
export function createTurnAuthorization(input: {
  readonly history: readonly AgentMessageView[]
  readonly prompt: string
  readonly references: readonly AgentImageReference[]
  /** 这一批引用的内容有没有随本轮输入附上；只影响清单措辞。 */
  readonly attached: boolean
  readonly carried?: string
}): TurnAuthorization {
  let authorized: TurnAuthorizationText = {
    revision: 0,
    instructions:
      input.carried ??
      turnAuthorizationText(input.history, input.prompt, input.references, input.attached),
  }
  return {
    current: () => authorized,
    amend(text, references, attached) {
      authorized = {
        revision: authorized.revision + 1,
        instructions: `${authorized.instructions}\n用户补充：${turnPromptText(text, references, attached)}`,
      }
    },
  }
}
