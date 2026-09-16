import { i18next } from '../../../i18n'
import { MATTE_BACKEND_LABELS } from '../../../lib/productMatte'
import { matteFailureLabels, type ProductShotVersion, type SourceMatte } from '../types'
import { maskSideFor } from './mode'

export interface MatteBadge {
  text: string
  tone: 'ok' | 'warn'
}

// `getFixedT(null, ns)` 把命名空间钉死、语言不钉：key 受 productShots 的类型约束，
// 每次调用仍取当前语言。手写 `Parameters<typeof i18next.t>[0]` 拿到的是全部命名空间的
// 并集，配上 `ns` 反而对不上，key 也就失去了编译期检查。
const t = i18next.getFixedT(null, 'productShots')

/** 版本条上的抠图标签：抠到了报后端，没抠到报原因。 */
export function matteBadge(version: ProductShotVersion): MatteBadge | null {
  // 整图重画的那几版本来就不抠图，「未抠图」在那里不是回落而是噪音。
  if (version.mode && !maskSideFor(version.mode)) return null
  const matte = version.matte
  if (version.masked) {
    if (!matte?.ok) return null
    return { text: MATTE_BACKEND_LABELS[matte.backend], tone: 'ok' }
  }
  if (matte && !matte.ok) {
    // 抠出来了但抠错了对象，跟根本没抠出来是两回事：用户要去看蒙版。
    if (matte.reason === 'box-mismatch') return { text: t('matte.unreliable'), tone: 'warn' }
    return {
      text: i18next.t('matte.notCutWith', {
        ns: 'productShots',
        reason: matteFailureLabels()[matte.reason],
      }),
      tone: 'warn',
    }
  }
  return { text: t('matte.notCut'), tone: 'warn' }
}

/** 原图卡上的抠图状态。没抠过又没在抠的旧记录不挂标签。 */
export function sourceMatteBadge(
  matte: SourceMatte | undefined,
  matting: boolean,
): MatteBadge | null {
  if (matting) return { text: t('matte.matting'), tone: 'warn' }
  if (!matte) return null
  if (matte.status === 'failed') {
    return {
      text: matte.reason === 'missing' ? matteFailureLabels().missing : t('matte.notMatted'),
      tone: 'warn',
    }
  }
  if (matte.status === 'unusable') {
    return { text: matteFailureLabels()[matte.reason], tone: 'warn' }
  }
  if (matte.edited) return { text: t('tag.edited'), tone: 'ok' }
  if (matte.agreement === 'box-mismatch') return { text: t('matte.unreliable'), tone: 'warn' }
  return {
    text: i18next.t('matte.cutWith', {
      ns: 'productShots',
      backend: MATTE_BACKEND_LABELS[matte.backend],
    }),
    tone: 'ok',
  }
}

/** 蒙版抠出来了但抠错了对象时动作区的那一句；动作照跑。 */
export function sourceMatteNotice(matte: SourceMatte | undefined): string | null {
  if (matte?.status !== 'ready') return null
  return matte.agreement === 'box-mismatch' ? t('matte.unreliable') : null
}
