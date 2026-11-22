import type {
  BillingPeriodMonths,
  BillingSettings,
  CreditBucket,
  LedgerEntry,
  ModelPrice,
  PlanPrice,
} from '@image-playground/shared'
import { type BillingKey, tBilling } from './i18n'

/** 模块级常量会把加载时的语言冻住，所以套餐兜底名只能在用到的时候现译。 */
export function noActiveSubscriptionLabel(): string {
  return tBilling('plan.noneActive')
}

const PLAN_NAME_KEYS = new Map<string, BillingKey>([
  ['starter', 'plan.starterName'],
  ['standard', 'plan.standardName'],
  ['professional', 'plan.professionalName'],
])

/**
 * 目录里的 `name` 是运营录入的中文名，不随语言变。公开 /pricing 按套餐 id 取译名，
 * 弹窗也照这个来，文案与公开 pricing.json 的同名 key 保持一致；不认识的 id 原样用目录名。
 */
export function planDisplayName(id: string | null | undefined, fallback: string): string {
  const key = id ? PLAN_NAME_KEYS.get(id) : undefined
  return key ? tBilling(key) : fallback
}

export interface UserBillingEntry extends Omit<LedgerEntry, 'bucket'> {
  bucket: CreditBucket | 'mixed'
}

/**
 * 账本保留预扣与结算事实；用户只看成功任务的净扣费。失败退款、后续补偿和账户调整仍单独展示。
 */
export function toUserBillingEntries(entries: readonly LedgerEntry[]): UserBillingEntry[] {
  const uniqueEntries: LedgerEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    uniqueEntries.push(entry)
  }

  const settlementTimes = new Map<string, number>()
  for (const entry of uniqueEntries) {
    if (!entry.task_id || entry.entry_type !== 'commit' || entry.amount !== 0) continue
    settlementTimes.set(entry.task_id, entry.created_at)
  }
  const isSettlementMarker = (entry: LedgerEntry): boolean => {
    if (!entry.task_id) return false
    if (entry.task_hold_status != null) {
      if (entry.task_hold_status !== 'committed' || entry.task_settled_at !== entry.created_at) {
        return false
      }
      return (
        (entry.entry_type === 'release' && entry.amount > 0) ||
        (entry.entry_type === 'commit' && entry.amount === 0)
      )
    }
    return (
      entry.entry_type === 'release' &&
      entry.amount > 0 &&
      settlementTimes.get(entry.task_id) === entry.created_at
    )
  }
  const netTaskIds = new Set<string>()
  for (const entry of uniqueEntries) {
    if (entry.task_id && isSettlementMarker(entry)) netTaskIds.add(entry.task_id)
  }

  const result: UserBillingEntry[] = []
  const eventGroups = new Map<string, UserBillingEntry>()
  const netGroups = new Map<string, { row: UserBillingEntry; taskNetSpend: number | null }>()
  const netRows = new Set<UserBillingEntry>()

  for (const entry of uniqueEntries) {
    const generation =
      entry.entry_type === 'hold' || entry.entry_type === 'commit' || entry.entry_type === 'release'
    const settlementMarker = isSettlementMarker(entry)
    const isNetEntry =
      entry.task_id &&
      netTaskIds.has(entry.task_id) &&
      (entry.entry_type === 'hold' || settlementMarker)

    if (isNetEntry && entry.task_id) {
      const taskNetSpend =
        typeof entry.task_net_spend === 'number' &&
        Number.isSafeInteger(entry.task_net_spend) &&
        entry.task_net_spend >= 0
          ? entry.task_net_spend
          : null
      const grouped = netGroups.get(entry.task_id)
      if (grouped) {
        grouped.row.amount += entry.amount
        if (grouped.row.bucket !== entry.bucket) grouped.row.bucket = 'mixed'
        grouped.row.created_at = Math.max(grouped.row.created_at, entry.created_at)
        if (taskNetSpend !== null) grouped.taskNetSpend = taskNetSpend
      } else {
        const row: UserBillingEntry = { ...entry, entry_type: 'hold' }
        result.push(row)
        netGroups.set(entry.task_id, { row, taskNetSpend })
        netRows.add(row)
      }
      continue
    }
    if (generation && entry.amount === 0) continue

    // 两个积分桶同一事件共用时间戳；较晚的补偿不能并进第一次退款。
    const key =
      entry.task_id && (entry.entry_type === 'hold' || entry.entry_type === 'release')
        ? `${entry.task_id}:${entry.entry_type}:${entry.created_at}:${Math.sign(entry.amount)}`
        : null
    const grouped = key ? eventGroups.get(key) : undefined
    if (grouped) {
      grouped.amount += entry.amount
      if (grouped.bucket !== entry.bucket) grouped.bucket = 'mixed'
      if (entry.note && grouped.note !== entry.note) {
        grouped.note = grouped.note ? `${grouped.note}；${entry.note}` : entry.note
      }
    } else {
      const row: UserBillingEntry = { ...entry }
      result.push(row)
      if (key) eventGroups.set(key, row)
    }
  }
  // A raw ledger page can end before the task's hold row. The joined task value keeps the
  // user-facing debit complete without changing or re-keying the canonical ledger events.
  for (const group of netGroups.values()) {
    if (group.taskNetSpend !== null) group.row.amount = -group.taskNetSpend
  }
  return result.filter((entry) => !netRows.has(entry) || entry.amount < 0)
}

function bucketLabel(entry: UserBillingEntry): string {
  if (entry.bucket === 'mixed') return tBilling('bucket.mixed')
  return entry.bucket === 'subscription'
    ? tBilling('bucket.subscription')
    : tBilling('bucket.recharge')
}

/**
 * 带复数的 key 一律同时传 `count` 与 `n`：`count` 是原始数字，只用来让 i18next 挑单复数分支；
 * `n` 是真正渲染进文案的值，积分那类要带千分位，数量这类保持原样。
 */
function quantityLabel(unit: ModelPrice['unit'], quantity: number): string {
  // 对话按 token 计价，quantity 恒为 1，报出来只会读成「1 张」。
  if (unit === 'kilo_token') return tBilling('ledger.quantityChat')
  if (unit === 'second') return tBilling('ledger.quantitySeconds', { count: quantity, n: quantity })
  return tBilling('ledger.quantityImages', { count: quantity, n: quantity })
}

function generationContext(entry: UserBillingEntry, modelPrices: ModelPrice[]): string {
  const model = entry.model ?? tBilling('ledger.unknownModel')
  const unit = modelPrices.find((price) => price.model === entry.model)?.unit ?? 'image'
  const quantity =
    entry.task_kind === 'analysis'
      ? tBilling('ledger.quantityAnalysis')
      : quantityLabel(unit, entry.quantity ?? 1)
  return `${model} · ${quantity} · ${bucketLabel(entry)}`
}

export function userBillingEntryTitle(entry: UserBillingEntry): string {
  if (entry.entry_type === 'grant') {
    const kind = entry.metadata.reward_kind
    if (kind === 'registration_inviter' || kind === 'registration_invitee')
      return tBilling('ledger.title.referralSignup')
    if (kind === 'transfer') return tBilling('ledger.title.rewardTransfer')
  }
  if (entry.entry_type === 'recharge') return tBilling('ledger.title.recharge')
  if (entry.entry_type === 'expire') return tBilling('ledger.title.expire')
  if (entry.entry_type === 'adjustment') return tBilling('ledger.title.adjustment')
  if (entry.entry_type === 'hold')
    return tBilling(
      entry.task_kind === 'analysis' ? 'ledger.title.analysisHold' : 'ledger.title.hold',
    )
  if (entry.entry_type === 'commit') return tBilling('ledger.title.commit')
  if (entry.entry_type === 'release')
    return entry.amount > 0 ? tBilling('ledger.title.refund') : tBilling('ledger.title.commit')
  return entry.bucket === 'subscription'
    ? tBilling('ledger.title.subscriptionGrant')
    : tBilling('ledger.title.bonusGrant')
}

export function userBillingEntryDescription(
  entry: UserBillingEntry,
  modelPrices: ModelPrice[] = [],
): string {
  const context = () => generationContext(entry, modelPrices)
  if (entry.entry_type === 'adjustment' && entry.note) return entry.note
  if (entry.entry_type === 'grant' && entry.note) return entry.note
  if (entry.entry_type === 'recharge') return entry.note || tBilling('ledger.description.recharge')
  if (entry.entry_type === 'expire') return tBilling('ledger.description.expire')
  if (entry.entry_type === 'adjustment') return tBilling('ledger.description.adjustment')
  if (entry.entry_type === 'hold') return context()
  if (entry.entry_type === 'commit')
    return tBilling('ledger.description.commit', { context: context() })
  if (entry.entry_type === 'release') {
    if (entry.note) return `${context()} · ${entry.note}`
    return entry.amount > 0
      ? tBilling('ledger.description.refunded', { context: context() })
      : tBilling('ledger.description.notRefunded', { context: context() })
  }
  return entry.bucket === 'subscription'
    ? tBilling('ledger.description.subscriptionGrant')
    : tBilling('ledger.description.bonusGrant')
}

export type ContactDisplay = { kind: 'qr'; src: string } | { kind: 'wechat'; text: string }

export function contactDisplay(
  settings: BillingSettings | null | undefined,
  fallbackText: string,
): ContactDisplay {
  const qr = settings?.contact_qr_url?.trim()
  if (qr) return { kind: 'qr', src: qr }
  return { kind: 'wechat', text: settings?.contact_wechat?.trim() || fallbackText }
}

export const PERIOD_ORDER: BillingPeriodMonths[] = [1, 3, 12]

const PERIOD_KEYS: Record<BillingPeriodMonths, BillingKey> = {
  1: 'period.monthly',
  3: 'period.quarterly',
  12: 'period.yearly',
}

export function periodLabel(months: BillingPeriodMonths): string {
  return tBilling(PERIOD_KEYS[months])
}

export function isDiscounted(price: PlanPrice): boolean {
  return price.effective_price_cents < price.original_price_cents
}

export interface ContactChannels {
  paymentQr: string | null
  contact: ContactDisplay
  guidance: string | null
}

export function contactChannels(
  settings: BillingSettings | null | undefined,
  fallbackText: string,
): ContactChannels {
  return {
    paymentQr: settings?.payment_qr_url?.trim() || null,
    contact: contactDisplay(settings, fallbackText),
    guidance: settings?.guidance?.trim() || null,
  }
}
