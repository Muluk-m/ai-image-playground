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
    const sum = known.reduce((total, job) => total + (job.chargedCredits ?? 0), 0)
    // 全部任务有实扣记录时，结果卡就是完整账本；部分旧记录尚无实扣时保留轮结算额。
    return known.length === relevant.length ? sum : Math.max(cost[media], sum)
  }
  return { ...cost, image: spent('image'), video: spent('video') }
}
