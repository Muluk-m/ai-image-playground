import type { ReactNode } from 'react'
import { ApiError } from '../../lib/private-host'

const fieldClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const buttonClass =
  'inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50'
const outlineButtonClass =
  'inline-flex h-9 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'

const decimal = new Intl.NumberFormat('zh-CN')

function credits(value: number): string {
  return decimal.format(value)
}

function dateTime(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString('zh-CN')
}

function dateOnly(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleDateString('zh-CN')
}

function toLocalInput(value: number): string {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

function parseLocalInput(value: string): number {
  return new Date(value).getTime()
}

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

function Section({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={['rounded-xl border bg-card/60 p-4 shadow-sm', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

const BILLING_ERROR_LABELS: Record<string, string> = {
  insufficient_recharge_credits: '充值积分不足，扣减不能超过当前可用余额。',
  credit_balance_overflow: '积分余额或累计奖励超过上限，请核对账户与返利设置。',
  invalid_amount: '请输入非零整数，正数补发、负数扣减。',
  reason_required: '请填写操作原因。',
  plan_not_found: '套餐不存在，请刷新后重新选择。',
  plan_inactive: '套餐已停用，请刷新后重新选择。',
  active_subscription_plan_mismatch: '当前已有其他套餐，请选择当前套餐续期。',
  scheduled_plan_change_exists: '已有待生效的换档，请等当前套餐到期后再更换档位。',
  renewal_start_after_current_end: '续期起始时间不能晚于当前套餐结束时间。',
  payment_conflict: '此操作编号已用于其他付款内容，请核对原实付记录。',
}

function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  const code =
    error instanceof ApiError &&
    typeof error.body === 'object' &&
    error.body !== null &&
    'error' in error.body
      ? error.body.error
      : undefined
  const message = typeof code === 'string' ? BILLING_ERROR_LABELS[code] : undefined
  return (
    <p role="alert" className="text-xs text-destructive">
      操作失败：{message ?? (error instanceof Error ? error.message : String(error))}
    </p>
  )
}

export {
  buttonClass,
  credits,
  dateOnly,
  dateTime,
  ErrorText,
  fieldClass,
  money,
  outlineButtonClass,
  parseLocalInput,
  Section,
  toLocalInput,
}
