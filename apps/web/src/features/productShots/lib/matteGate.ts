import { MATTE_FAILURE_LABELS, type SourceMatte } from '../types'

const MATTING = '抠图中'
const FAILED = '抠图失败'

export interface MatteReadiness {
  matte: SourceMatte | undefined
  matting: boolean
  /** 模型不支持遮罩时抠图根本不跑，动作照走无蒙版那条路，不能挡。 */
  maskSupported: boolean
}

export interface MatteBlock {
  reason: string
  retry: boolean
  edit: boolean
}

/** 蒙版还不能用时挡住动作；null = 可以跑。只问要遮罩的动作。 */
export function matteGate({ matte, matting, maskSupported }: MatteReadiness): MatteBlock | null {
  if (!maskSupported) return null
  if (matting || !matte) return { reason: MATTING, retry: false, edit: false }
  if (matte.status === 'failed') return { reason: FAILED, retry: true, edit: false }
  if (matte.status === 'unusable') {
    return { reason: `抠图${MATTE_FAILURE_LABELS[matte.reason]}`, retry: true, edit: true }
  }
  return null
}
