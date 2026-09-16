import { i18next } from '../../../i18n'
import { matteFailureLabels, type SourceMatte } from '../types'

// `getFixedT(null, ns)` 把命名空间钉死、语言不钉：key 受 productShots 的类型约束，
// 每次调用仍取当前语言。手写 `Parameters<typeof i18next.t>[0]` 拿到的是全部命名空间的
// 并集，配上 `ns` 反而对不上，key 也就失去了编译期检查。
const t = i18next.getFixedT(null, 'productShots')

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
  if (!modelKnown) return { reason: t('matte.staleModel'), retry: false, edit: false }
  if (!maskSupported) return null
  if (matting || !matte) return { reason: t('matte.matting'), retry: false, edit: false }
  if (matte.status === 'failed') {
    return {
      reason: matte.reason === 'missing' ? matteFailureLabels().missing : t('matte.failed'),
      retry: true,
      edit: false,
    }
  }
  if (matte.status === 'unusable') {
    return {
      reason: i18next.t('matte.blockedCoverage', {
        ns: 'productShots',
        reason: matteFailureLabels()[matte.reason],
      }),
      retry: true,
      edit: true,
    }
  }
  return null
}
