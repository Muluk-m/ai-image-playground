import { requestedImageCount } from '@image-playground/shared'
import type { AgentToolMessage } from '../types'
import type { AgentReservation } from './canvasSink'

/**
 * 这张草稿卡确认之后会出几件产物：工具写了张数用工具的，否则用用户本轮选择的张数。
 * 视频一次只出一件；旧记录与坏值都按一件算，画布不会铺出一片空框。
 */
export function agentDraftOutputCount(message: AgentToolMessage): number {
  if (message.toolName === 'generateVideo') return 1
  return requestedImageCount(message.snapshot?.args?.n, message.snapshot?.params?.n)
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

export function isProductionDraft(message: AgentToolMessage): boolean {
  return (
    message.productionDraftRevision !== undefined || Boolean(message.snapshot?.params?.production)
  )
}
