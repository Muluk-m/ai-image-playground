import { type MatteBadge, matteBadge } from '../lib/matteBadge'
import type { ProductShotVersion } from '../types'

const TONE = {
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
}

export function BadgeTag({ badge, className }: { badge: MatteBadge | null; className: string }) {
  if (!badge) return null
  return <span className={`rounded ${className} ${TONE[badge.tone]}`}>{badge.text}</span>
}

/** 抠图标签。版本条与结果总览共用它，免得两处对「哪些动作该报抠图」各判一次。 */
export default function MatteTag({
  version,
  className,
}: {
  version: ProductShotVersion
  className: string
}) {
  return <BadgeTag badge={matteBadge(version)} className={className} />
}
