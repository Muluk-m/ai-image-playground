import type { AgentTurnCost } from '@image-playground/shared'
import type { AgentToolMessage } from '../types'

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
