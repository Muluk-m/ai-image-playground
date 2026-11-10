/**
 * 聊天里的短确认语判定与前端拦截条。
 * `isShortConfirmation` 与服务端共用 `@image-playground/shared` 里的同一份实现。
 */
import { isShortConfirmation } from '@image-playground/shared'

export { isShortConfirmation }

export function shouldHoldConfirmation(text: string, pendingCount: number): boolean {
  return pendingCount > 0 && isShortConfirmation(text)
}

/** 有待确认的生成卡时，聊天短确认语应直接提交这些卡，不再当成新消息发出去。 */
export function shouldSubmitPendingDraftsFromChat(
  text: string,
  pending: readonly { readonly kind: string }[],
  referenceCount = 0,
): boolean {
  // 带了参考图就按新消息处理，与服务端 `shouldSubmitChatConfirmation` 一致。
  return (
    referenceCount === 0 && pending.some((one) => one.kind === 'draft') && isShortConfirmation(text)
  )
}
