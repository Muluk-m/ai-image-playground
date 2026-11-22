export type CreditAllocation =
  | { ok: true; subscription: number; recharge: number }
  | { ok: false; required: number; available: number }

/**
 * 积分向上取整。单价乘倍率是浮点运算，200 × 9.8 得到 1960.0000000000002，
 * 直接取整会多扣 1 分；先舍到百万分之一再向上取整，只去掉浮点尾数，真实的小数照样进位。
 */
export function ceilCredits(value: number): number {
  return Math.ceil(Math.round(value * 1e6) / 1e6)
}

/** 预扣与结算必须用同一条取整规则，否则结算的封顶会悄悄退多或退少。 */
export function creditsFor(input: {
  creditsPerUnit: number
  quantity: number
  unitMultiplier: number
}): number {
  return ceilCredits(input.creditsPerUnit * input.quantity * input.unitMultiplier)
}

export function allocateCredits(
  required: number,
  subscriptionBalance: number,
  rechargeBalance: number,
): CreditAllocation {
  const available = subscriptionBalance + rechargeBalance
  if (required > available) return { ok: false, required, available }
  const subscription = Math.min(required, subscriptionBalance)
  return { ok: true, subscription, recharge: required - subscription }
}

export function addCalendarMonths(timestamp: number, months: number): number {
  const source = new Date(timestamp)
  const total = source.getUTCMonth() + months
  const targetYear = source.getUTCFullYear() + Math.floor(total / 12)
  const targetMonth = ((total % 12) + 12) % 12
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return Date.UTC(
    targetYear,
    targetMonth,
    Math.min(source.getUTCDate(), daysInTargetMonth),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  )
}
export function nextMonthlyOccurrence(
  anchorTimestamp: number,
  occurrenceTimestamp: number,
): number {
  const anchor = new Date(anchorTimestamp)
  const occurrence = new Date(occurrenceTimestamp)
  const elapsedMonths =
    (occurrence.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    occurrence.getUTCMonth() -
    anchor.getUTCMonth()
  if (elapsedMonths < 0) throw new Error('occurrence_before_anchor')
  return addCalendarMonths(anchorTimestamp, elapsedMonths + 1)
}

export function effectivePrice(
  originalPriceCents: number,
  discountPriceCents: number | null,
  discountEndsAt: number | null,
  now = Date.now(),
): number {
  if (discountPriceCents === null || discountEndsAt === null || now > discountEndsAt) {
    return originalPriceCents
  }
  return discountPriceCents
}

const DAY_MS = 86_400_000
const ACTIVITY_RANGE_MAX_DAYS = 366

export class InvalidRangeError extends Error {
  constructor() {
    super('invalid_range')
    this.name = 'InvalidRangeError'
  }
}

/** en-CA 的日期格式恰好是 YYYY-MM-DD，换 locale 会悄悄换成别的格式。 */
export function dayInTimezone(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(timestamp)
}

function parseDay(day: string): number {
  const timestamp = Date.parse(`${day}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(timestamp)) throw new InvalidRangeError()
  if (new Date(timestamp).toISOString().slice(0, 10) !== day) throw new InvalidRangeError()
  return timestamp
}

function shiftDays(day: string, days: number): string {
  return new Date(parseDay(day) + days * DAY_MS).toISOString().slice(0, 10)
}

export function resolveActivityRange(input: { from?: string; to?: string; today: string }): {
  from: string
  to: string
} {
  const to = input.to ?? input.today
  const from = input.from ?? shiftDays(to, -(ACTIVITY_RANGE_MAX_DAYS - 1))
  const span = (parseDay(to) - parseDay(from)) / DAY_MS + 1
  if (span < 1 || span > ACTIVITY_RANGE_MAX_DAYS) throw new InvalidRangeError()
  return { from, to }
}
