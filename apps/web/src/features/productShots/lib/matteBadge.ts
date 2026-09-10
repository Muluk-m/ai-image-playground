import { MATTE_BACKEND_LABELS } from '../../../lib/productMatte'
import { MATTE_FAILURE_LABELS, type ProductShotVersion, type SourceMatte } from '../types'
import { maskSideFor } from './mode'

export interface MatteBadge {
  text: string
  tone: 'ok' | 'warn'
}

const UNRELIABLE = '蒙版不可靠'

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
    if (matte.reason === 'box-mismatch') return { text: UNRELIABLE, tone: 'warn' }
    return { text: `未抠图 · ${MATTE_FAILURE_LABELS[matte.reason]}`, tone: 'warn' }
  }
  return { text: '未抠图', tone: 'warn' }
}

/** 原图卡上的抠图状态。没抠过又没在抠的旧记录不挂标签。 */
export function sourceMatteBadge(
  matte: SourceMatte | undefined,
  matting: boolean,
): MatteBadge | null {
  if (matting) return { text: '抠图中', tone: 'warn' }
  if (!matte) return null
  if (matte.status === 'failed') {
    return {
      text: matte.reason === 'missing' ? MATTE_FAILURE_LABELS.missing : '未抠',
      tone: 'warn',
    }
  }
  if (matte.status === 'unusable') return { text: MATTE_FAILURE_LABELS[matte.reason], tone: 'warn' }
  if (matte.edited) return { text: '手改', tone: 'ok' }
  if (matte.agreement === 'box-mismatch') return { text: UNRELIABLE, tone: 'warn' }
  return { text: `已抠 · ${MATTE_BACKEND_LABELS[matte.backend]}`, tone: 'ok' }
}

/** 蒙版抠出来了但抠错了对象时动作区的那一句；动作照跑。 */
export function sourceMatteNotice(matte: SourceMatte | undefined): string | null {
  if (matte?.status !== 'ready') return null
  return matte.agreement === 'box-mismatch' ? UNRELIABLE : null
}
