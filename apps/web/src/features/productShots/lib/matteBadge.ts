import { MATTE_BACKEND_LABELS, MATTE_FAILURE_LABELS } from '../../../lib/productMatte'
import type { ProductShotVersion } from '../types'
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
    return matte?.ok ? { text: MATTE_BACKEND_LABELS[matte.backend], tone: 'ok' } : null
  }
  if (matte && !matte.ok) {
    // 抠出来了但抠错了对象，跟根本没抠出来是两回事：用户要去看蒙版。
    if (matte.reason === 'box-mismatch') return { text: UNRELIABLE, tone: 'warn' }
    return { text: `未抠图 · ${MATTE_FAILURE_LABELS[matte.reason]}`, tone: 'warn' }
  }
  return { text: '未抠图', tone: 'warn' }
}
