import { MATTE_FAILURE_LABELS, type SourceMatte } from '../types'

const MATTING = '抠图中'
const FAILED = '抠图失败'
const STALE_MODEL = '模型信息已过期，请刷新页面'

export interface MatteReadiness {
  matte: SourceMatte | undefined
  matting: boolean
  /** 模型不支持遮罩时抠图根本不跑，动作照走无蒙版那条路，不能挡。 */
  maskSupported: boolean
  /** 客户端认不出这个模型时 maskSupported 是猜的，不能拿它当「不需要遮罩」。 */
  modelKnown: boolean
}

export interface MatteBlock {
  reason: string
  retry: boolean
  edit: boolean
}

/** 蒙版还不能用时挡住动作；null = 可以跑。只问要遮罩的动作。 */
export function matteGate({
  matte,
  matting,
  maskSupported,
  modelKnown,
}: MatteReadiness): MatteBlock | null {
  if (!modelKnown) return { reason: STALE_MODEL, retry: false, edit: false }
  if (!maskSupported) return null
  if (matting || !matte) return { reason: MATTING, retry: false, edit: false }
  if (matte.status === 'failed') {
    return {
      reason: matte.reason === 'missing' ? MATTE_FAILURE_LABELS.missing : FAILED,
      retry: true,
      edit: false,
    }
  }
  if (matte.status === 'unusable') {
    return { reason: `抠图${MATTE_FAILURE_LABELS[matte.reason]}`, retry: true, edit: true }
  }
  return null
}
