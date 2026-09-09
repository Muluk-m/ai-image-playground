import type { SourceMatte } from '../types'
import type { ProductShotAction } from './actions'
import { maskSideFor } from './mode'

const MATTING = '抠图中'
/** 只有这一条能重试；抠图中是等，不是失败。 */
export const MATTE_FAILED = '抠图失败'

export interface MatteReadiness {
  matte: SourceMatte | undefined
  matting: boolean
  /** 模型不支持遮罩时抠图根本不跑，动作照走无蒙版那条路，不能挡。 */
  maskSupported: boolean
}

/** 要遮罩的动作在蒙版落地前不给提交；null = 可以跑。 */
export function matteGateReason(
  mode: ProductShotAction,
  { matte, matting, maskSupported }: MatteReadiness,
): string | null {
  if (!maskSideFor(mode) || !maskSupported) return null
  if (matting || !matte) return MATTING
  return matte.status === 'failed' ? MATTE_FAILED : null
}
