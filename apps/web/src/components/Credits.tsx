/**
 * 全站唯一的积分写法：闪电 + 千分位，`⚡1,234`。
 *
 * 选图标版不是因为好看，是因为私有树 Header 一直这么写，而那里是用户最常看积分的位置；
 * 别处再换一套写法，用户就要在同一屏里认两种「积分」。图标也更装得进页脚、明细行、
 * 工具卡这些窄位置。
 *
 * 但图标不能是唯一信息来源：整块挂 `role="img"` 与写着「积分」两个字的 `aria-label`，
 * 首次见到闪电的用户不靠猜。
 */

import { useTranslation } from '../i18n'
import { formatCount } from '../i18n/format'

export function formatCredits(credits: number): string {
  return formatCount(credits)
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M7.1 1 2.5 7.1h2.4L4.5 11l4.6-6.1H6.7z" />
    </svg>
  )
}

export default function Credits({
  credits,
  className = '',
  struck = false,
}: {
  credits: number
  className?: string
  /** 划掉整块（闪电 + 数字）：只划数字时那道线太短，扫一眼看不出来。 */
  struck?: boolean
}) {
  const { t } = useTranslation('shell')
  const amount = formatCredits(credits)
  const content = (
    <>
      <BoltIcon />
      <span aria-hidden="true">{amount}</span>
    </>
  )
  return (
    <span
      role="img"
      aria-label={t('credits.ariaLabel', { amount })}
      className={`inline-flex items-center gap-0.5 tabular-nums ${className}`}
    >
      {struck ? (
        <del className="inline-flex items-center gap-0.5 decoration-[1.5px] opacity-70">
          {content}
        </del>
      ) : (
        content
      )}
    </span>
  )
}
