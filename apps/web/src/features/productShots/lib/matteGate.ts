import type { SourceMatte } from '../types'

const MATTING = '抠图中'
/** 只有这一条能重试：抠图中是在等，不是失败。 */
export const MATTE_FAILED_REASON = '抠图失败'

export interface MatteReadiness {
  matte: SourceMatte | undefined
  matting: boolean
  /** 模型不支持遮罩时抠图根本不跑，动作照走无蒙版那条路，不能挡。 */
  maskSupported: boolean
}

/** 蒙版还不能用时挡住动作的那一句；null = 可以跑。只问要遮罩的动作。 */
export function matteGateReason({ matte, matting, maskSupported }: MatteReadiness): string | null {
  if (!maskSupported) return null
  if (matting || !matte) return MATTING
  return matte.status === 'failed' ? MATTE_FAILED_REASON : null
}
