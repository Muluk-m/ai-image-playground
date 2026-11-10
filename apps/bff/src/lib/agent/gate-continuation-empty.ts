/**
 * 确认门续跑（按钮或聊天确认后的 `pickUpGateContinuation` → `agent.continue()`）
 * 有时模型只回几个 token、不落任何可见正文或工具块。普通用户轮仍按空轮失败；
 * 续跑则补一句固定说明，避免「图已经在生成」却弹出 This turn did not finish。
 *
 * BFF 面向用户的助手说明沿用中文硬编码（与 `queueTask`、确认门回执同一套做法）。
 */
export const GATE_CONTINUATION_EMPTY_REPLY = '已提交生成，结果会显示在卡片里。'

export function shouldFillEmptyGateContinuation(input: {
  readonly continuation: boolean
  readonly error: boolean
  readonly aborted: boolean
  readonly storedAny: boolean
  readonly openText: boolean
}): boolean {
  return input.continuation && !input.error && !input.aborted && !input.storedAny && !input.openText
}
