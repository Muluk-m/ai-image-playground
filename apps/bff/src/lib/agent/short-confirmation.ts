import { isShortConfirmation } from '@image-playground/shared'
import type { BatchFact, ConversationStateFacts } from './conversation-state'

/**
 * 聊天短确认语的服务端硬拦截：不依赖模型自律。
 *
 * 有待确认卡片或目标批次已经出完时，直接给出固定回复，这一轮不再问模型。
 * 这样 generateImage / editImage / generateVideo / runNodes / planImageBatch /
 * proposeBatchGeneration / runStoryboardFrames 都不会被调用，也避开图片模式
 * 把「确认，执行生成」原话直送 generateImage（见 `direct-image.ts`）。
 */
export type ShortConfirmationReason = 'pending' | 'completed' | 'in_progress'

export interface ShortConfirmationGuard {
  readonly reason: ShortConfirmationReason
  readonly reply: string
}

const MAX_LISTED_ARTIFACTS = 12

export function shortConfirmationGuard(
  text: string,
  facts: ConversationStateFacts,
  options: { readonly inClarification?: boolean } = {},
): ShortConfirmationGuard | undefined {
  // 澄清里的「可以 / 确认」是在回答当前问题，不是对旧批次再点一次执行。
  if (options.inClarification || !isShortConfirmation(text)) return undefined

  const pendingDrafts = facts.pendingDrafts.length
  const pendingNodeRuns = facts.pendingNodeRuns.length
  const draftBatches = facts.batches.filter((batch) => batch.status === 'draft')
  if (pendingDrafts > 0 || pendingNodeRuns > 0 || draftBatches.length > 0) {
    return { reason: 'pending', reply: pendingReply(pendingDrafts, pendingNodeRuns, draftBatches) }
  }

  const finished = facts.batches.filter((batch) => batch.status === 'closed')
  if (finished.length) return { reason: 'completed', reply: completedReply(finished) }

  const active = facts.batches.filter(
    (batch) => batch.status === 'running' || batch.status === 'paused',
  )
  if (active.length) return { reason: 'in_progress', reply: activeReply(active) }

  return undefined
}

function pendingReply(
  pendingDrafts: number,
  pendingNodeRuns: number,
  draftBatches: readonly BatchFact[],
): string {
  const parts: string[] = []
  if (pendingDrafts > 0) parts.push(`${pendingDrafts} 张待确认的生成`)
  if (pendingNodeRuns > 0) parts.push(`${pendingNodeRuns} 组待确认的节点运行`)
  if (draftBatches.length > 0) {
    const titles = draftBatches.map((batch) => `「${batch.title}」`).join('、')
    parts.push(`${draftBatches.length} 份待确认的批次计划${titles ? `：${titles}` : ''}`)
  }
  return `聊天里回复确认不会开始生成。当前还有${parts.join('、')}，请在卡片上点确认。`
}

function completedReply(batches: readonly BatchFact[]): string {
  const lines = batches.map((batch) => {
    const listed = batch.artifactIds.slice(0, MAX_LISTED_ARTIFACTS)
    const more = batch.artifactIds.length - listed.length
    const failed = batch.failed ? `，失败 ${batch.failed}` : ''
    const artifacts = listed.length
      ? `；产物：${listed.join('、')}${more > 0 ? ` 等 ${batch.artifactIds.length} 张` : ''}`
      : ''
    return `批次 ${batch.batchId}「${batch.title}」已完成 ${batch.completed}/${batch.itemCount}${failed}${artifacts}`
  })
  return `这批已经出完了，不用再确认执行，我不会重新提交生成。\n${lines.join('\n')}`
}

function activeReply(batches: readonly BatchFact[]): string {
  const lines = batches.map((batch) => {
    const verb = batch.status === 'paused' ? '已暂停' : '还在执行中'
    return `批次 ${batch.batchId}「${batch.title}」${verb}，已完成 ${batch.completed}/${batch.itemCount}`
  })
  return `当前批次还没结束，不用在聊天里再次确认，我不会重新提交生成。\n${lines.join('\n')}`
}
