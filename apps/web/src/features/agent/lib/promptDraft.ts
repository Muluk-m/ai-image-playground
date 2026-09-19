import { AGENT_IMAGE_MAX_N } from '@image-playground/shared'
import type { AgentToolMessage } from '../types'
import type { AgentReservation } from './canvasSink'

/**
 * 这张草稿卡确认之后会出几件产物：模型在起跑快照里给的张数，按协议上限收口。
 * 视频一次只出一件；旧记录与坏值都按一件算，画布不会铺出一片空框。
 */
export function agentDraftOutputCount(message: AgentToolMessage): number {
  if (message.toolName === 'generateVideo') return 1
  const count = message.snapshot?.args.n
  if (typeof count !== 'number' || !Number.isFinite(count)) return 1
  return Math.min(AGENT_IMAGE_MAX_N, Math.max(1, Math.trunc(count)))
}

/**
 * 确认之后照这个在画布上占位：草稿卡没有 `toolStart` 那一刻的占位（拟稿不出图，也不占位），
 * 提交生成任务的是确认这一下，位要在这时候才占。
 */
export function agentDraftReservation(
  message: AgentToolMessage,
  conversationId: string,
): AgentReservation {
  return {
    count: agentDraftOutputCount(message),
    media: message.toolName === 'generateVideo' ? 'video' : 'image',
    title: message.title,
    conversationId,
    ...(message.anchorObjectId ? { anchorObjectId: message.anchorObjectId } : {}),
  }
}
