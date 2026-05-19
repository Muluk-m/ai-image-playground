// InputBar prompt 文本框自适应高度计算。
//
// textarea 高度规则：
//   - 内容很少时按 scrollHeight 撑出实际高度，但不低于 PROMPT_MIN_H（≈ 1 行）；
//   - 撑高时上限是「视口 40% 减去卡片内其它固定开销（图片 thumbs / 参数行等）」，
//     再触底有 80px 的下限保护，避免极小屏被压成 0；
//   - 超过 targetH 时 textarea 内部出滚动条。

/** textarea 永远不会缩到比这更小（≈ 1 行 + padding）。 */
export const PROMPT_MIN_H = 42

export interface PromptHeightInput {
  /** textarea 此刻 scrollHeight，由调用方测量。 */
  scrollH: number
  /** 当前视口高度（window.innerHeight）。 */
  innerHeight: number
  /** 同卡片其它固定元素占的高度（图片 thumbs + 参数行 + padding 等）。 */
  fixedOverhead: number
}

export interface PromptHeightOutput {
  /** textarea 最终要应用的 height（px）。 */
  targetH: number
  /** 内容是否超出 targetH——用来切 textarea 的 overflowY: auto / hidden。 */
  scroll: boolean
}

export function computePromptHeight(input: PromptHeightInput): PromptHeightOutput {
  const maxH = Math.max(input.innerHeight * 0.4 - input.fixedOverhead, 80)
  const desired = Math.max(input.scrollH, PROMPT_MIN_H)
  return {
    targetH: Math.min(desired, maxH),
    scroll: desired > maxH,
  }
}
