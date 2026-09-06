import { MATTE_BACKEND_LABELS, MATTE_FAILURE_LABELS } from '../../../lib/productMatte'
import type { BgSwapVersion } from '../types'

export interface MatteBadge {
  text: string
  tone: 'ok' | 'warn'
}

/** 版本条上的抠图标签：抠到了报后端，没抠到报原因。 */
export function matteBadge(version: BgSwapVersion): MatteBadge | null {
  const matte = version.matte
  if (version.masked) {
    return matte?.ok ? { text: MATTE_BACKEND_LABELS[matte.backend], tone: 'ok' } : null
  }
  const reason = matte && !matte.ok ? MATTE_FAILURE_LABELS[matte.reason] : null
  return { text: reason ? `未抠图 · ${reason}` : '未抠图', tone: 'warn' }
}
