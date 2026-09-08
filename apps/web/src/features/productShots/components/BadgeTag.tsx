import type { MatteBadge } from '../lib/matteBadge'

const TONE = {
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
}

/** 抠图状态的小标签。原图、批量列表与版本条共用它。 */
export default function BadgeTag({
  badge,
  className,
}: {
  badge: MatteBadge | null
  className: string
}) {
  if (!badge) return null
  return <span className={`rounded ${className} ${TONE[badge.tone]}`}>{badge.text}</span>
}
