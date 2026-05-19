// InputBar prompt 文本框高度计算 + 折叠阈值判定。
//
// 设计目标：让长 prompt 不要把背景的任务卡片顶得看不见。当文字超过 ~3 行时
// 显示折叠按钮；用户主动折叠后把 textarea 限高在 PROMPT_COLLAPSED_MAX_H，
// 内容仍可在 textarea 内滚动。

/** prompt 折叠后的最大高度（≈ 3 行 leading-relaxed text-sm）。 */
export const PROMPT_COLLAPSED_MAX_H = 84
/** prompt textarea 永远不会缩到比这更小（≈ 1 行 + padding）。 */
export const PROMPT_MIN_H = 42

export interface PromptHeightInput {
  /** textarea 此刻 scrollHeight，由调用方测量。 */
  scrollH: number
  /** 当前视口高度（window.innerHeight）。 */
  innerHeight: number
  /** 同卡片其它固定元素占的高度（图片 thumbs + 参数行 + padding 等）。 */
  fixedOverhead: number
  /** 用户是否主动点折叠按钮。 */
  promptCollapsed: boolean
}

export interface PromptHeightOutput {
  /** textarea 最终要应用的 height（px）。 */
  targetH: number
  /** 内容是否超过「3 行」阈值——用来决定是否显示折叠按钮。 */
  overflow: boolean
  /** 内容是否超出 targetH——用来切 textarea 的 overflowY: auto / hidden。 */
  scroll: boolean
}

export function computePromptHeight(input: PromptHeightInput): PromptHeightOutput {
  const expandedMaxH = Math.max(input.innerHeight * 0.4 - input.fixedOverhead, 80)
  const maxH = input.promptCollapsed ? Math.min(expandedMaxH, PROMPT_COLLAPSED_MAX_H) : expandedMaxH
  const desired = Math.max(input.scrollH, PROMPT_MIN_H)
  return {
    targetH: Math.min(desired, maxH),
    overflow: desired > PROMPT_COLLAPSED_MAX_H,
    scroll: desired > maxH,
  }
}
