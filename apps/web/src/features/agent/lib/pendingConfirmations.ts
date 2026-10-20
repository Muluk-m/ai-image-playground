import type { AgentPanelMessage } from '../types'
import { isProductionDraft } from './promptDraft'

export type ConfirmationHint =
  | { readonly kind: 'draft'; readonly messageId: string }
  | { readonly kind: 'nodeRun'; readonly messageId: string }
  | { readonly kind: 'batch'; readonly messageId: string; readonly batchId: string }

let cachedMessages: readonly AgentPanelMessage[] | undefined
let cachedHintKey = ''

/**
 * 给输入栏订阅用。消息数组每次流式更新都是新的，但待确认清单没变时返回同一条字符串，
 * 避免整段输入栏跟着每个字重画。
 */
export function confirmationHintKey(messages: readonly AgentPanelMessage[]): string {
  if (messages === cachedMessages) return cachedHintKey
  const next = JSON.stringify(confirmationHints(messages))
  cachedMessages = messages
  if (next === cachedHintKey) return cachedHintKey
  cachedHintKey = next
  return next
}

/** 面板上可能还等着用户点一下的卡。批次要再对上「仍是草稿」才算数。 */
export function confirmationHints(messages: readonly AgentPanelMessage[]): ConfirmationHint[] {
  const hints: ConfirmationHint[] = []
  for (const message of messages) {
    if (message.kind !== 'tool') continue
    if (message.status === 'awaiting_confirmation' && !isProductionDraft(message)) {
      hints.push({ kind: 'draft', messageId: message.id })
      continue
    }
    if (message.canvasRun && !message.canvasRun.autoRun) {
      hints.push({ kind: 'nodeRun', messageId: message.id })
      continue
    }
    if (message.batchId)
      hints.push({ kind: 'batch', messageId: message.id, batchId: message.batchId })
  }
  return hints
}

export function resolvePendingConfirmations(
  hints: readonly ConfirmationHint[],
  draftBatchIds: ReadonlySet<string>,
  nodeRunStarted: (messageId: string) => boolean,
): ConfirmationHint[] {
  const seenBatches = new Set<string>()
  return hints.filter((hint) => {
    if (hint.kind === 'draft') return true
    if (hint.kind === 'nodeRun') return !nodeRunStarted(hint.messageId)
    if (seenBatches.has(hint.batchId) || !draftBatchIds.has(hint.batchId)) return false
    seenBatches.add(hint.batchId)
    return true
  })
}
