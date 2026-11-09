import { randomUUID } from 'node:crypto'
import type { GptDirectAdminView, GptDirectKeyStatus } from '@image-playground/shared'
import { gte, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { kickAppAlerts } from '../../ops/alert-kick'
import { log } from '../logger'
import { readMasterKey } from '../upstream-secrets'
import {
  directKeySpent,
  directSpentThisMonth,
  keyBudgetCapMicroUsd,
  releaseDirectReservation,
  reserveDirectBudget,
} from './gpt-budget'
import {
  adminDirectKeys,
  configuredDirectKeys,
  type DirectKey,
  directKeySecrets,
  displayDirectKeyError,
  FingerprintSecretMissingError,
  fingerprintMacSource,
  noteDirectSizeDeliverable,
  scrubSecrets,
} from './gpt-key-config'
import { readOfficialDirectCosts } from './gpt-official-costs'

/**
 * 直连密钥的运行状态写在 `gpt_direct_key_state`，所有 worker 共用。
 * 额度耗尽和密钥失效一直停到后台恢复；429 只冷却一段时间；预算用满不落停用标记，
 * 下个月花费窗口滑走就自己恢复。
 */

const BUDGET_TIME_ZONE = 'Asia/Taipei'

type KeyStateRow = typeof schema.gpt_direct_key_state.$inferSelect

export class DirectKeysExhaustedError extends Error {
  readonly causeError: unknown
  readonly upstreamStatus?: number

  constructor(cause: unknown) {
    super('openai direct keys exhausted')
    this.name = 'DirectKeysExhaustedError'
    this.causeError = cause
    const status = (cause as { upstreamStatus?: unknown } | null)?.upstreamStatus
    if (typeof status === 'number') this.upstreamStatus = status
  }
}

export type DirectKeyFailure = 'quota' | 'invalid' | 'cooldown'

function errorText(error: unknown): { status?: number; code: string; message: string } {
  const statusValue = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus
  const status = typeof statusValue === 'number' ? statusValue : undefined
  const payload = (error as { upstreamPayload?: unknown } | null)?.upstreamPayload
  let code = ''
  if (payload && typeof payload === 'object') {
    const body = (payload as { error?: { code?: unknown; type?: unknown } }).error
    if (body && typeof body === 'object') {
      code = [body.code, body.type].filter((part) => typeof part === 'string').join(' ')
    }
  }
  const message = error instanceof Error ? error.message : ''
  return { ...(status !== undefined ? { status } : {}), code, message }
}

/** 这把 key 要不要让位。参数错、5xx、结果未知都不在这里：那些仍走原来的换路。 */
export function classifyDirectKeyFailure(error: unknown): DirectKeyFailure | null {
  const { status, code, message } = errorText(error)
  const blob = `${code} ${message}`.toLowerCase()
  if (
    status === 401 ||
    /invalid_api_key|invalid api key|incorrect api key|api key provided/.test(blob)
  ) {
    return 'invalid'
  }
  if (
    /insufficient_quota|billing_hard_limit_reached|billing_not_active|account_deactivated|exceeded your current quota/.test(
      blob,
    )
  ) {
    return 'quota'
  }
  if (status === 429) return 'cooldown'
  return null
}

function publicError(error: unknown): string {
  const { message, code, status } = errorText(error)
  return (
    displayDirectKeyError(
      scrubSecrets(message || code || `HTTP ${status ?? ''}`, directKeySecrets()),
    ) || 'upstream rejected the key'
  )
}

async function loadKeyState(): Promise<Map<string, KeyStateRow>> {
  const rows = await db.select().from(schema.gpt_direct_key_state)
  return new Map(rows.map((row) => [row.fingerprint, row]))
}

async function walkDirectKeys(input: {
  estimateMicroUsd: number
  exclude?: ReadonlySet<string>
  now?: number
  reserve?: boolean
}): Promise<{ key: DirectKey; reservationId: string | null } | null> {
  const now = input.now ?? Date.now()
  let keys: DirectKey[]
  try {
    keys = configuredDirectKeys()
  } catch (err) {
    log.warn({ event: 'gpt.direct_keys_invalid', err }, 'openai direct key config is invalid')
    return null
  }
  if (keys.length === 0) {
    if (!input.exclude?.size) noteDirectSizeDeliverable(false)
    return null
  }
  let state: Map<string, KeyStateRow>
  try {
    state = await loadKeyState()
  } catch (err) {
    log.warn({ event: 'gpt.direct_key_state_read_failed', err }, 'direct key state read failed')
    return null
  }
  for (const key of keys) {
    if (input.exclude?.has(key.fingerprint) || key.enabled === false) continue
    const row = state.get(key.fingerprint)
    if (row?.disabled_reason) continue
    if (row?.cooldown_until && row.cooldown_until > now) continue
    const cap = keyBudgetCapMicroUsd(key.budgetUsd)
    try {
      if (input.reserve) {
        const reservationId = await reserveDirectBudget({
          fingerprint: key.fingerprint,
          includeUnattributed: key.ordinal === 1,
          estimateMicroUsd: input.estimateMicroUsd,
          capMicroUsd: cap,
          now,
        })
        if (!reservationId) continue
        if (!input.exclude?.size) noteDirectSizeDeliverable(true)
        return { key, reservationId }
      }
      const spent = await directKeySpent(key.fingerprint, key.ordinal === 1, now, true)
      if (spent + input.estimateMicroUsd > cap) continue
    } catch (err) {
      log.warn(
        { event: 'gpt.direct_budget_read_failed', err, fingerprint: key.label },
        'direct budget read failed',
      )
      return null
    }
    if (!input.exclude?.size) noteDirectSizeDeliverable(true)
    return { key, reservationId: null }
  }
  if (!input.exclude?.size) noteDirectSizeDeliverable(false)
  return null
}

/** 按配置顺序挑第一把还能用的 key。读状态或预算失败就一张都不用，退回 sub2api。 */
export async function selectDirectKey(input: {
  estimateMicroUsd: number
  exclude?: ReadonlySet<string>
  now?: number
}): Promise<DirectKey | null> {
  const picked = await walkDirectKeys(input)
  return picked?.key ?? null
}

/** 选中并预占估算额度。调用方必须记账或释放。 */
export async function reserveDirectKey(input: {
  estimateMicroUsd: number
  exclude?: ReadonlySet<string>
  now?: number
}): Promise<{ key: DirectKey; reservationId: string } | null> {
  const picked = await walkDirectKeys({ ...input, reserve: true })
  if (!picked?.reservationId) return null
  return { key: picked.key, reservationId: picked.reservationId }
}

export async function releaseDirectKeyReservation(id: string): Promise<void> {
  await releaseDirectReservation(id)
}

async function writeKeyState(
  fingerprint: string,
  set: {
    disabled_reason?: 'quota' | 'invalid' | null
    cooldown_until?: number | null
    last_error: string
    last_error_at: number
  },
): Promise<void> {
  const now = Date.now()
  await db
    .insert(schema.gpt_direct_key_state)
    .values({
      fingerprint,
      disabled_reason: set.disabled_reason ?? null,
      cooldown_until: set.cooldown_until ?? null,
      last_error: set.last_error,
      last_error_at: set.last_error_at,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: schema.gpt_direct_key_state.fingerprint,
      set: {
        ...(set.disabled_reason !== undefined ? { disabled_reason: set.disabled_reason } : {}),
        ...(set.cooldown_until !== undefined ? { cooldown_until: set.cooldown_until } : {}),
        last_error: set.last_error,
        last_error_at: set.last_error_at,
        updated_at: now,
      },
    })
}

export async function markDirectKeyDisabled(
  key: DirectKey,
  reason: 'quota' | 'invalid',
  error: unknown,
): Promise<void> {
  try {
    await writeKeyState(key.fingerprint, {
      disabled_reason: reason,
      cooldown_until: null,
      last_error: publicError(error),
      last_error_at: Date.now(),
    })
  } catch (err) {
    log.warn(
      { event: 'gpt.direct_key_disable_failed', err, fingerprint: key.label },
      'failed to persist direct key disable',
    )
  }
}

export async function markDirectKeyCooldown(key: DirectKey, error: unknown): Promise<void> {
  const now = Date.now()
  try {
    await writeKeyState(key.fingerprint, {
      cooldown_until: now + config.scheduler.rateLimitCooldownMs,
      last_error: publicError(error),
      last_error_at: now,
    })
  } catch (err) {
    log.warn(
      { event: 'gpt.direct_key_cooldown_failed', err, fingerprint: key.label },
      'failed to persist direct key cooldown',
    )
  }
}

interface DirectKeyAlertEvent {
  fingerprint: string
  label: string
  reason: 'quota' | 'invalid'
}

const alertListeners = new Set<(event: DirectKeyAlertEvent) => void>()

export function _setDirectKeyAlertForTesting(
  listener?: (event: DirectKeyAlertEvent) => void,
): void {
  alertListeners.clear()
  if (listener) alertListeners.add(listener)
}

/** 停用已经落库。告警和换下一把同时发生：这里只踢一轮扫描，不等 webhook。 */
export function notifyDirectKeyDisabled(key: DirectKey, reason: 'quota' | 'invalid'): void {
  const event = { fingerprint: key.fingerprint, label: key.label, reason }
  log.warn(
    { event: 'gpt.direct_key_disabled', fingerprint: key.label, reason },
    'openai direct key disabled',
  )
  for (const listener of alertListeners) {
    try {
      listener(event)
    } catch (err) {
      log.warn(
        { event: 'gpt.direct_key_alert_listener_failed', err },
        'direct key alert listener failed',
      )
    }
  }
  kickAppAlerts()
}

/** 清掉停用和冷却。预算用满是算出来的，恢复之后这个月仍超预算就还是用满。 */
export async function restoreDirectKey(fingerprint: string, operator?: string): Promise<boolean> {
  const key = configuredDirectKeys().find((candidate) => candidate.fingerprint === fingerprint)
  if (!key) return false
  const now = Date.now()
  const operatorId = (operator?.trim() || 'admin').slice(0, 200)
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.gpt_direct_key_state)
      .values({
        fingerprint,
        disabled_reason: null,
        cooldown_until: null,
        last_error: null,
        last_error_at: null,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: schema.gpt_direct_key_state.fingerprint,
        set: { disabled_reason: null, cooldown_until: null, updated_at: now },
      })
    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: operatorId,
      action: 'gpt_direct_key.restore',
      target_type: 'gpt_direct_key',
      target_id: fingerprint,
      details: { fingerprint: key.label },
      created_at: now,
    })
  })
  log.info(
    {
      event: 'gpt.direct_key_restored',
      fingerprint: key.label,
      ...(operator ? { operator } : {}),
    },
    'openai direct key restored',
  )
  return true
}

function statusOf(
  key: { enabled: boolean },
  row: KeyStateRow | undefined,
  spent: number,
  cap: number,
  now: number,
): GptDirectKeyStatus {
  if (key.enabled === false) return 'off'
  if (row?.disabled_reason) return 'disabled'
  if (spent >= cap) return 'budget'
  if (row?.cooldown_until && row.cooldown_until > now) return 'cooldown'
  return 'available'
}

function taipeiDay(ts: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUDGET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ts)
}

function recentTaipeiDays(days: number, now: number): string[] {
  const noon = Date.parse(`${taipeiDay(now)}T12:00:00+08:00`)
  const list: string[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    list.push(taipeiDay(noon - offset * 86_400_000))
  }
  return list
}

export async function directKeyPanel(days: 7 | 30, now = Date.now()): Promise<GptDirectAdminView> {
  const { refreshGptDirectKeys } = await import('./gpt-direct-admin')
  await refreshGptDirectKeys()
  // 环境变量清单解析不了（格式错、缺指纹密钥）时面板照样打开，只是没有密钥可列、也不能写，
  // 并把原因给运维看；不能让 GET 直接 500，运维连页面都进不去就没法修。
  let keys: DirectKey[] = []
  let configProblem: string | null = null
  try {
    keys = configuredDirectKeys()
  } catch (err) {
    configProblem =
      err instanceof FingerprintSecretMissingError
        ? err.message
        : '直连密钥配置无效，详见服务端日志（gpt.direct_keys_invalid）'
    log.warn(
      { event: 'gpt.direct_keys_invalid', err: err instanceof Error ? err.name : 'error' },
      'openai direct key config is invalid',
    )
  }
  const state = keys.length > 0 ? await loadKeyState() : new Map<string, KeyStateRow>()
  const views = []
  for (const key of keys) {
    const spent = await directKeySpent(key.fingerprint, key.ordinal === 1, now)
    const cap = keyBudgetCapMicroUsd(key.budgetUsd)
    const row = state.get(key.fingerprint)
    views.push({
      id: key.id,
      ordinal: key.ordinal,
      fingerprint: key.fingerprint,
      label: key.label,
      enabled: key.enabled,
      source: key.id ? ('admin' as const) : ('env' as const),
      status: statusOf(key, row, spent, cap, now),
      disabled_reason: row?.disabled_reason ?? null,
      budget_usd: key.budgetUsd,
      budget_micro_usd: cap,
      spent_micro_usd: spent,
      cooldown_until: row?.cooldown_until ?? null,
      last_error: displayDirectKeyError(row?.last_error ?? null),
      last_error_at: row?.last_error_at ?? null,
    })
  }
  const spent = await directSpentThisMonth(now)
  const cap = views.reduce((sum, key) => sum + key.budget_micro_usd, 0)
  const dayList = recentTaipeiDays(days, now)
  const windowStart = Date.parse(`${dayList[0]}T00:00:00+08:00`)
  const rows = await db
    .select({
      day: sql<string>`to_char(${schema.gpt_direct_usage.created_at} at time zone 'Asia/Taipei', 'YYYY-MM-DD')`,
      cost: sql<string | null>`sum(${schema.gpt_direct_usage.cost_micro_usd})`,
      images: sql<string | null>`sum(${schema.gpt_direct_usage.images})`,
    })
    .from(schema.gpt_direct_usage)
    .where(gte(schema.gpt_direct_usage.created_at, windowStart))
    .groupBy(
      sql`to_char(${schema.gpt_direct_usage.created_at} at time zone 'Asia/Taipei', 'YYYY-MM-DD')`,
    )
  const byDay = new Map(
    rows.map((row) => [row.day, { cost: Number(row.cost ?? 0), images: Number(row.images ?? 0) }]),
  )
  const master = readMasterKey()
  const source = adminDirectKeys() === null ? 'env' : 'admin'
  const revisionRows = await db
    .select({ updated_at: schema.gpt_direct_admin_keys.updated_at })
    .from(schema.gpt_direct_admin_keys)
  return {
    generated_at: now,
    currency_note: 'usage',
    days,
    source,
    revision: revisionRows.reduce((max, row) => Math.max(max, row.updated_at), 0),
    fingerprint_mac_source: fingerprintMacSource(),
    writable: master.ok && configProblem === null,
    disabled_reason: configProblem ?? (master.ok ? null : master.reason),
    keys: views,
    total_spent_micro_usd: spent,
    total_budget_micro_usd: cap,
    remaining_micro_usd: Math.max(0, cap - spent),
    daily: dayList.map((day) => ({
      day,
      cost_micro_usd: byDay.get(day)?.cost ?? 0,
      images: byDay.get(day)?.images ?? 0,
    })),
    official: await readOfficialDirectCosts(days, now),
  }
}

/** 告警轮询用：当前仍因上游错误停用、且后台没有手动关闭的密钥。标签来自配置，库里只有指纹。 */
export async function disabledDirectKeys(): Promise<
  Array<{ fingerprint: string; label: string; reason: 'quota' | 'invalid' }>
> {
  // 配置解析失败就让它抛：告警层把抛错当成「没观察到」，保持原状态；
  // 返回空数组会把还停着的密钥误报成已恢复。
  const configured = configuredDirectKeys()
  const labels = new Map(configured.map((key) => [key.fingerprint, key.label]))
  const adminRows = await db
    .select({
      fingerprint: schema.gpt_direct_admin_keys.fingerprint,
      enabled: schema.gpt_direct_admin_keys.enabled,
    })
    .from(schema.gpt_direct_admin_keys)
  const manuallyDisabled = new Set(
    adminRows.filter((row) => !row.enabled).map((row) => row.fingerprint),
  )
  const rows = await db
    .select({
      fingerprint: schema.gpt_direct_key_state.fingerprint,
      disabled_reason: schema.gpt_direct_key_state.disabled_reason,
    })
    .from(schema.gpt_direct_key_state)
  return rows.flatMap((row) => {
    const label = labels.get(row.fingerprint)
    if (!label || manuallyDisabled.has(row.fingerprint)) return []
    return row.disabled_reason === 'quota' || row.disabled_reason === 'invalid'
      ? [{ fingerprint: row.fingerprint, label, reason: row.disabled_reason }]
      : []
  })
}
