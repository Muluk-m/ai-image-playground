import type { AgentTurnCost } from '@image-playground/shared'
import type { AgentPanelMessage, AgentToolMessage } from '../types'

/**
 * 后台生成可能在对话轮收尾后才结算（确认生成必然如此）。结果卡保存每笔实扣，
 * 页脚里的轮结算额则覆盖较早完成的任务；同一笔不能加两次。
 */
export function turnCostWithJobs(
  cost: AgentTurnCost,
  jobs: readonly AgentToolMessage[],
): AgentTurnCost {
  const spent = (media: 'image' | 'video'): number => {
    const relevant = jobs.flatMap((message) => (message.job?.media === media ? [message.job] : []))
    if (!relevant.length) return cost[media]
    const known = relevant.filter((job) => job.chargedCredits !== undefined)
    if (cost.includedTaskIds) {
      const included = new Set(cost.includedTaskIds)
      const later = known.filter((job) => !included.has(job.taskId))
      return cost[media] + later.reduce((total, job) => total + (job.chargedCredits ?? 0), 0)
    }
    // 旧页脚没有任务快照；只能维持已结算金额，并补上它原本为零的轮后扣费。
    const sum = known.reduce((total, job) => total + (job.chargedCredits ?? 0), 0)
    return Math.max(cost[media], sum)
  }
  return { ...cost, image: spent('image'), video: spent('video') }
}

/**
 * 一轮有出图结果时，页脚写成带张数的结算行。它只能放在这一轮最后：
 * 结果卡正好是本轮最后一条，就由卡片自己带出（`cardId`）；后面还有取消的卡或文字，就留给对话末尾。
 */
export function turnImageReceipt(
  messages: readonly AgentPanelMessage[],
  turnId: string,
): { cardId?: string; outputCount: number } | null {
  let last = -1
  let card = -1
  messages.forEach((message, index) => {
    if (message.turnId !== turnId) return
    last = index
    if (
      message.kind === 'tool' &&
      (message.toolName === 'generateImage' || message.toolName === 'editImage') &&
      message.status === 'succeeded' &&
      message.artifacts?.some((artifact) => artifact.media === 'image')
    )
      card = index
  })
  const found = messages[card]
  if (!found || found.kind !== 'tool') return null
  return {
    cardId: card === last ? found.id : undefined,
    outputCount: found.artifacts?.length ?? 0,
  }
}
