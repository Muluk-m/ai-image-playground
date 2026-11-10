/**
 * 聊天里的短确认语判定与前端拦截条。
 * `isShortConfirmation` 与服务端共用 `@image-playground/shared` 里的同一份实现。
 */
import { isShortConfirmation } from '@image-playground/shared'

export { isShortConfirmation }

export function shouldHoldConfirmation(text: string, pendingCount: number): boolean {
  return pendingCount > 0 && isShortConfirmation(text)
}
