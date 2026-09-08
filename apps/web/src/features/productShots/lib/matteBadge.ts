import { MATTE_BACKEND_LABELS, MATTE_FAILURE_LABELS } from '../../../lib/productMatte'
import type { ProductShotVersion, SourceMatte } from '../types'
import { maskSideFor } from './mode'

export interface MatteBadge {
  text: string
  tone: 'ok' | 'warn'
}

const UNRELIABLE = '蒙版不可靠'
const SERVER = '服务端'
const BROWSER = '浏览器'

/** 版本条上的抠图标签：抠到了报后端，没抠到报原因。 */
export function matteBadge(version: ProductShotVersion): MatteBadge | null {
  // 整图重画的那几版本来就不抠图，「未抠图」在那里不是回落而是噪音。
  if (version.mode && !maskSideFor(version.mode)) return null
  const matte = version.matte
  if (version.masked) {
    if (!matte?.ok) return null
    return { text: matte.backend ? MATTE_BACKEND_LABELS[matte.backend] : SERVER, tone: 'ok' }
  }
  if (matte && !matte.ok) {
    // 抠出来了但抠错了对象，跟根本没抠出来是两回事：用户要去看蒙版。
    if (matte.reason === 'box-mismatch') return { text: UNRELIABLE, tone: 'warn' }
    return { text: `未抠图 · ${MATTE_FAILURE_LABELS[matte.reason]}`, tone: 'warn' }
  }
  return { text: '未抠图', tone: 'warn' }
}

/** 原图卡上的抠图状态。 */
export function sourceMatteBadge(matte: SourceMatte | undefined): MatteBadge | null {
  if (!matte) return null
  if (matte.status === 'pending') return { text: '抠图中', tone: 'warn' }
  if (matte.status === 'failed') return { text: '未抠', tone: 'warn' }
  if (matte.edited) return { text: '手改', tone: 'ok' }
  if (matte.agreement === 'box-mismatch') return { text: UNRELIABLE, tone: 'warn' }
  return { text: `已抠 · ${matte.source === 'server' ? SERVER : BROWSER}`, tone: 'ok' }
}
