import type { MatteAssessment, ProductAlpha } from './types'

export const MIN_PRODUCT_COVERAGE = 0.03
export const MAX_PRODUCT_COVERAGE = 0.9

const PRODUCT_ALPHA_THRESHOLD = 128

/** 占比异常说明模型没抠到产品（过小）或把整张图当成产品（过大），两种都不能拿去重绘背景。 */
export function assessMatte(matte: ProductAlpha): MatteAssessment {
  const total = matte.width * matte.height
  if (total <= 0) return { ok: false, coverage: 0, reason: 'too-small' }

  let product = 0
  for (let i = 0; i < total; i++) {
    if (matte.alpha[i] >= PRODUCT_ALPHA_THRESHOLD) product++
  }

  const coverage = product / total
  if (coverage < MIN_PRODUCT_COVERAGE) return { ok: false, coverage, reason: 'too-small' }
  if (coverage > MAX_PRODUCT_COVERAGE) return { ok: false, coverage, reason: 'too-large' }
  return { ok: true, coverage }
}
