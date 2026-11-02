/**
 * 聊天里的短确认语。批次已经出完或卡片还挂着时，这种话不是新的创作要求
 * （2026-10-16 会话 20911719：用户发「确认，执行生成」，同一批又被提交了一遍）。
 *
 * 只认整句都由确认词拼成、并且不超过 10 个字的话。「可以再来一版」这种带了新要求的短句不拦。
 */
const CONFIRMATION_TOKENS = [
  '确认执行生成',
  '确认生成',
  '开始生成',
  '执行生成',
  '确认执行',
  '确认',
  '可以',
  '执行',
] as const

export function isShortConfirmation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || [...trimmed].length > 10) return false
  let rest = trimmed.replace(/[\s,，.。!！?？、~～]+/g, '')
  if (!rest) return false
  while (rest) {
    const token = CONFIRMATION_TOKENS.find((one) => rest.startsWith(one))
    if (!token) return false
    rest = rest.slice(token.length)
  }
  return true
}

export function shouldHoldConfirmation(text: string, pendingCount: number): boolean {
  return pendingCount > 0 && isShortConfirmation(text)
}
