/** 产品清单与视觉提示都不许写死品类词，这个表只在测试里当反模式探针，不得进生产代码。 */
export const HARD_CODED_PARTS = new RegExp(
  ['龙头', '排水', '把手', '底座', 'faucet', 'drain', 'handles', 'feet'].join('|'),
)
