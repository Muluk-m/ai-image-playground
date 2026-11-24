import type {
  UserAccountSnapshot as AccountSnapshot,
  Catalog as CatalogSnapshot,
  CreditAccount,
  ModelPrice,
  SpendActivity,
} from '@image-playground/shared'
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  authenticatedBffFetch,
  formatCount,
  formatDateMinute,
  getRuntimeConfig,
  isClientCapabilityEnabled,
} from '../../lib/privateHost'
import type { PrivateSubmissionGuard, PrivateSubmissionInput } from '../../lib/privateOverlay'
import { tBilling } from './i18n'

export interface BillingSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error'
  account: AccountSnapshot | null
  catalog: CatalogSnapshot | null
  error: string | null
}

export const OPEN_BILLING_EVENT = 'image-playground:open-billing'
export const OPEN_RECHARGE_EVENT = 'image-playground:open-recharge'
export const OPEN_PRICING_EVENT = 'private-billing:open-pricing'
const listeners = new Set<() => void>()
let snapshot: BillingSnapshot = { status: 'idle', account: null, catalog: null, error: null }
let pendingLoad: Promise<void> | null = null

function emit(next: BillingSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): BillingSnapshot {
  return snapshot
}

function bffUrl(path: string): string {
  return `${getRuntimeConfig().bff.baseUrl.replace(/\/+$/, '')}${path}`
}

export async function readBillingJson<T>(path: string): Promise<T> {
  const response = await authenticatedBffFetch(bffUrl(path), {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`billing_http_${response.status}`)
  return (await response.json()) as T
}

export interface ActivitySnapshot {
  status: 'loading' | 'ready' | 'error'
  activity: SpendActivity | null
  total: number
}

const LOADING_ACTIVITY: ActivitySnapshot = { status: 'loading', activity: null, total: 0 }

export async function readSpendActivity(): Promise<ActivitySnapshot> {
  try {
    const activity = await readBillingJson<SpendActivity>('/api/billing/activity')
    return {
      status: 'ready',
      activity,
      total: activity.days.reduce((sum, day) => sum + day.count, 0),
    }
  } catch {
    return { status: 'error', activity: null, total: 0 }
  }
}

export function useSpendActivity(): { snapshot: ActivitySnapshot; retry: () => void } {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(LOADING_ACTIVITY)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setSnapshot(LOADING_ACTIVITY)
    void readSpendActivity().then((next) => {
      if (live) setSnapshot(next)
    })
    return () => {
      live = false
    }
  }, [attempt])
  return { snapshot, retry: () => setAttempt((n) => n + 1) }
}

type UnmeteredSnapshot = NonNullable<AccountSnapshot['unmetered']>

function parseUnmetered(value: unknown): UnmeteredSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (
    typeof record.user_id !== 'string' ||
    !Number.isSafeInteger(record.daily_quota) ||
    !Number.isSafeInteger(record.guaranteed_concurrency) ||
    !Number.isSafeInteger(record.idle_concurrency) ||
    typeof record.enabled !== 'boolean' ||
    !Number.isFinite(record.updated_at)
  )
    return null
  return record as UnmeteredSnapshot
}

/**
 * `/api/billing/account` 正常是 `{ account, subscription, ledger, model_prices, catalog }`。
 * 右上角积分直接读 `account.account.subscription_balance`，外层对象在、内层积分账户不在时会把整棵
 * React 树打崩。这里把缺内层但顶层自带余额的回包补成同一形状，认不出余额就返回 null。
 */
export function normalizeAccountSnapshot(value: unknown): AccountSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const nested = record.account
  const unmetered = parseUnmetered(record.unmetered)
  const accessState = record.access_state === 'access_denied' ? 'access_denied' : null
  if (accessState) {
    return {
      account: null,
      subscription: null,
      ledger: [],
      model_prices: Array.isArray(record.model_prices) ? (record.model_prices as ModelPrice[]) : [],
      catalog: (record.catalog as AccountSnapshot['catalog']) ?? {
        plans: [],
        settings: null,
        model_prices: [],
      },
      access_state: accessState,
      unmetered,
    }
  }
  if (unmetered && (nested === null || nested === undefined)) {
    const snapshot = value as AccountSnapshot
    return {
      account: null,
      subscription: snapshot.subscription ?? null,
      ledger: Array.isArray(snapshot.ledger) ? snapshot.ledger : [],
      model_prices: Array.isArray(snapshot.model_prices) ? snapshot.model_prices : [],
      catalog: snapshot.catalog ?? { plans: [], settings: null, model_prices: [] },
      unmetered,
    }
  }
  const source = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : record
  if (
    typeof source.subscription_balance !== 'number' ||
    typeof source.recharge_balance !== 'number'
  )
    return null
  const credits: CreditAccount = {
    subscription_balance: source.subscription_balance,
    recharge_balance: source.recharge_balance,
    subscription_expires_at:
      typeof source.subscription_expires_at === 'number' ? source.subscription_expires_at : null,
  }
  const snapshot = value as AccountSnapshot
  return {
    account: credits,
    subscription: snapshot.subscription ?? null,
    ledger: Array.isArray(snapshot.ledger) ? snapshot.ledger : [],
    model_prices: Array.isArray(snapshot.model_prices) ? snapshot.model_prices : [],
    catalog: snapshot.catalog ?? { plans: [], settings: null, model_prices: [] },
    unmetered,
  }
}

/** 积分账户不完整时返回 null，调用方显示「还没读到」，不要读 undefined 上的字段。 */
export function availableCredits(account: AccountSnapshot | null | undefined): number | null {
  const credits = account?.account
  if (
    !credits ||
    typeof credits.subscription_balance !== 'number' ||
    typeof credits.recharge_balance !== 'number'
  ) {
    return null
  }
  return credits.subscription_balance + credits.recharge_balance
}

export function loadBilling(): Promise<void> {
  if (!isClientCapabilityEnabled('billing:credits')) return Promise.resolve()
  if (pendingLoad) return pendingLoad
  emit({ ...snapshot, status: 'loading', error: null })
  pendingLoad = readBillingJson<AccountSnapshot>('/api/billing/account')
    .then((body) => {
      const account = normalizeAccountSnapshot(body)
      if (!account) {
        // 这次回包认不出余额。已有一份可用账户就留着，并回到 ready：上面刚把 status 写成 loading，
        // 沿用它会让充值面板一直停在「加载中」。
        const keep = availableCredits(snapshot.account) !== null
        emit({
          ...snapshot,
          status: keep ? 'ready' : 'error',
          error: keep ? null : 'billing_account_invalid',
        })
        return
      }
      emit({ status: 'ready', account, catalog: account.catalog, error: null })
    })
    .catch((error: unknown) =>
      emit({
        ...snapshot,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      pendingLoad = null
    })
  return pendingLoad
}
export async function refreshBillingAfterSettlement(): Promise<void> {
  const inFlight = pendingLoad
  if (inFlight) await inFlight
  await loadBilling()
}

export function useBilling(): BillingSnapshot {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    if (getSnapshot().status === 'idle') void loadBilling()
  }, [])
  return value
}

type BillingModalIntent = 'pricing' | 'recharge'
const PENDING_BILLING_MODAL_KEY = 'muvloom:pending-billing-modal'
const PENDING_BILLING_MODAL_TTL_MS = 10 * 60 * 1000
let pendingBillingModal: BillingModalIntent | null = null

function readStoredBillingModal(): BillingModalIntent | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_BILLING_MODAL_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { modal?: unknown; expiresAt?: unknown }
    if (
      (parsed.modal === 'pricing' || parsed.modal === 'recharge') &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt > Date.now()
    ) {
      return parsed.modal
    }
    window.sessionStorage.removeItem(PENDING_BILLING_MODAL_KEY)
  } catch {
    // sessionStorage 不可用时退回内存状态。
  }
  return null
}

function clearStoredBillingModal(): void {
  pendingBillingModal = null
  try {
    window.sessionStorage.removeItem(PENDING_BILLING_MODAL_KEY)
  } catch {
    // 忽略存储异常。
  }
}

export function queueBillingModal(modal: BillingModalIntent): void {
  pendingBillingModal = modal
  try {
    window.sessionStorage.setItem(
      PENDING_BILLING_MODAL_KEY,
      JSON.stringify({ modal, expiresAt: Date.now() + PENDING_BILLING_MODAL_TTL_MS }),
    )
  } catch {
    // 忽略存储异常，内存态仍可用。
  }
}

export function hasPendingBillingModal(): boolean {
  return (pendingBillingModal ?? readStoredBillingModal()) !== null
}

export function consumePendingBillingModal(): BillingModalIntent | null {
  const next = pendingBillingModal ?? readStoredBillingModal()
  clearStoredBillingModal()
  return next
}

export function openBilling(): void {
  window.dispatchEvent(new Event(OPEN_BILLING_EVENT))
}

export function openPricing(): void {
  clearStoredBillingModal()
  window.dispatchEvent(new Event(OPEN_PRICING_EVENT))
}

export function openRecharge(): void {
  clearStoredBillingModal()
  window.dispatchEvent(new Event(OPEN_RECHARGE_EVENT))
}

export function formatCredits(value: number): string {
  return formatCount(value)
}

export function formatDate(value: number | null): string {
  if (value === null) return '—'
  return formatDateMinute(value)
}

export function formatMoney(cents: number): string {
  return `¥${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`
}

export function approximateImages(creditAmount: number, modelPrices: ModelPrice[]): number | null {
  const anchor = modelPrices.find((price) => price.active && price.model === 'gpt-image-2')
  if (!anchor || anchor.credits_per_image <= 0) return null
  return Math.floor(creditAmount / anchor.credits_per_image)
}

export function submissionGuard(
  { model, quantity, unitMultiplier = 1 }: PrivateSubmissionInput,
  billing: BillingSnapshot,
): PrivateSubmissionGuard {
  if (!isClientCapabilityEnabled('billing:credits')) return { blocked: false }
  if (billing.account?.access_state === 'access_denied') {
    return { blocked: true, disabledReason: tBilling('guard.accountUnavailable') }
  }
  if (billing.account?.unmetered?.enabled) return { blocked: false, metering: 'none' }
  if (billing.status === 'error') {
    return { blocked: true, disabledReason: tBilling('guard.accountUnavailable') }
  }
  if (!billing.account) return { blocked: true, disabledReason: tBilling('guard.calculating') }
  const available = availableCredits(billing.account)
  if (available === null) return { blocked: true, disabledReason: tBilling('guard.calculating') }
  const prices = billing.account.model_prices
  if (!Array.isArray(prices)) return { blocked: true, disabledReason: tBilling('guard.noPrice') }
  const price = prices.find((entry) => entry.active && entry.model === model)
  if (!price) return { blocked: true, disabledReason: tBilling('guard.noPrice') }
  // 与 BFF 的 ceilCredits 同一条规则：去掉浮点尾数再进位，提示金额与实际预扣一致。
  const exact = price.credits_per_image * quantity * unitMultiplier
  const required = Math.ceil(Math.round(exact * 1e6) / 1e6)
  if (available < required) {
    return {
      blocked: true,
      disabledReason: tBilling('guard.insufficient', {
        required: formatCredits(required),
        available: formatCredits(available),
      }),
      blockedAction: { label: tBilling('action.recharge'), run: openRecharge },
      estimatedCredits: required,
      availableCredits: available,
    }
  }
  return { blocked: false, estimatedCredits: required, availableCredits: available }
}

export function useSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard {
  return submissionGuard(input, useBilling())
}

export function getSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard {
  return submissionGuard(input, getSnapshot())
}

export function onSubmissionAccepted(): void {
  void loadBilling()
}

export function onSubmissionError(error: unknown): void {
  const candidate = error as { insufficientCredits?: unknown }
  if (candidate?.insufficientCredits === true) openBilling()
}

export function onSubmissionSettled(): void {
  void refreshBillingAfterSettlement()
}
