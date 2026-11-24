import type { GeminiDirectAdminView, GeminiDirectKeyStatus } from '@image-playground/shared'
import { eq, gte, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import { readMasterKey } from '../upstream-secrets'
import {
  geminiKeyBudgetCapMicroUsd,
  geminiKeySpent,
  geminiSpentThisMonth,
  releaseGeminiReservation,
  reserveGeminiBudget,
} from './gemini-budget'
import {
  adminGeminiDirectKeys,
  configuredGeminiDirectKeys,
  displayGeminiKeyError,
  forgetGeminiDirectKeyDisabled,
  type GeminiDirectKey,
  geminiDirectKeyKnownDisabled,
  geminiDirectKeySecrets,
} from './gemini-key-config'
import { fingerprintMacSource } from './gpt-direct-availability'
import { FingerprintSecretMissingError, scrubSecrets } from './gpt-key-config'

/**
 * Gemini 直连（Vertex / Nano Banana）密钥池的跨 worker 运行状态与统计面板查询。
 * - `quota` / `invalid` 持久停用，直到后台手动恢复；
 * - `cooldown`（429 限流）冷却一段时间并立即切换下一把可用 key；
 * - 月预算用满不写停用标记，自然月翻篇自动恢复。
 */

const BUDGET_TIME_ZONE = 'Asia/Taipei'

type KeyStateRow = typeof schema.gemini_direct_key_state.$inferSelect

export class GeminiDirectKeysExhaustedError extends Error {
  readonly causeError: unknown
  readonly upstreamStatus?: number
  readonly retryable = false

  constructor(
    cause?: unknown,
    message = 'Gemini 直连密钥均已达到月预算上限或不可用，请在后台补充或恢复密钥',
  ) {
    super(message)
    this.name = 'GeminiDirectKeysExhaustedError'
    this.causeError = cause
    const status = (cause as { upstreamStatus?: unknown } | null)?.upstreamStatus
    if (typeof status === 'number') this.upstreamStatus = status
  }
}

export type GeminiKeyFailure = 'quota' | 'invalid' | 'cooldown'

function errorText(error: unknown): { status?: number; code: string; message: string } {
  const statusValue = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus
  const status = typeof statusValue === 'number' ? statusValue : undefined
  const payload = (error as { upstreamPayload?: unknown } | null)?.upstreamPayload
  let code = ''
  if (payload && typeof payload === 'object') {
    const body = (payload as { error?: { status?: unknown; message?: unknown; code?: unknown } })
      .error
    if (body && typeof body === 'object') {
      code = [body.status, body.message, body.code]
        .filter((part) => typeof part === 'string')
        .join(' ')
    }
  }
  const message = error instanceof Error ? error.message : ''
  return { ...(status !== undefined ? { status } : {}), code, message }
}

/** 判定这把 Gemini/Vertex key 是否应停用或冷却让位。参数错（400）、5xx、内容审核不在这里。 */
export function classifyGeminiKeyFailure(error: unknown): GeminiKeyFailure | null {
  const { status, code, message } = errorText(error)
  const blob = `${code} ${message}`.toLowerCase()
  if (
    status === 401 ||
    /api_key_invalid|api key not valid|invalid api key|unauthenticated/.test(blob) ||
    (status === 403 && /permission_denied|api key|forbidden|credentials/.test(blob))
  ) {
    return 'invalid'
  }
  if (
    /billing_disabled|billing account|billing not enabled|exceeded your current quota|quota_exceeded|daily limit exceeded/.test(
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
    displayGeminiKeyError(
      scrubSecrets(message || code || `HTTP ${status ?? ''}`, geminiDirectKeySecrets()),
    ) || 'upstream rejected the key'
  )
}

async function loadKeyState(): Promise<Map<string, KeyStateRow>> {
  const rows = await db.select().from(schema.gemini_direct_key_state)
  return new Map(rows.map((row) => [row.fingerprint, row]))
}

export interface WalkGeminiKeysResult {
  key: GeminiDirectKey
  reservationId: string | null
}

export async function walkGeminiDirectKeys(input: {
  estimateMicroUsd: number
  exclude?: ReadonlySet<string>
  now?: number
  reserve?: boolean
  allowCooldown?: boolean
  state?: ReadonlyMap<string, KeyStateRow>
}): Promise<WalkGeminiKeysResult | null> {
  const now = input.now ?? Date.now()
  let keys: GeminiDirectKey[]
  try {
    keys = configuredGeminiDirectKeys()
  } catch (err) {
    log.warn({ event: 'gemini.direct_keys_invalid', err }, 'gemini direct key config is invalid')
    return null
  }
  if (keys.every((key) => !key.enabled || geminiDirectKeyKnownDisabled(key.fingerprint))) {
    return null
  }
  let state: ReadonlyMap<string, KeyStateRow>
  try {
    state = input.state ?? (await loadKeyState())
  } catch (err) {
    log.warn({ event: 'gemini.direct_key_state_read_failed', err }, 'gemini key state read failed')
    return null
  }
  for (const key of keys) {
    if (input.exclude?.has(key.fingerprint) || key.enabled === false) continue
    const row = state.get(key.fingerprint)
    if (row?.disabled_reason) continue
    if (!input.allowCooldown && row?.cooldown_until && row.cooldown_until > now) continue
    const cap = geminiKeyBudgetCapMicroUsd(key.budgetUsd)
    try {
      if (input.reserve) {
        const reservationId = await reserveGeminiBudget({
          fingerprint: key.fingerprint,
          includeUnattributed: key.ordinal === 1,
          estimateMicroUsd: input.estimateMicroUsd,
          capMicroUsd: cap,
          now,
        })
        if (!reservationId) continue
        return { key, reservationId }
      }
      const spent = await geminiKeySpent(key.fingerprint, key.ordinal === 1, now, true)
      if (spent + input.estimateMicroUsd > cap) continue
      return { key, reservationId: null }
    } catch (err) {
      log.warn(
        { event: 'gemini.direct_budget_read_failed', err, fingerprint: key.label },
        'gemini direct budget read failed',
      )
      return null
    }
  }
  return null
}

export async function selectGeminiDirectKey(input: {
  estimateMicroUsd: number
  exclude?: ReadonlySet<string>
  now?: number
  state?: ReadonlyMap<string, KeyStateRow>
}): Promise<GeminiDirectKey | null> {
  const picked = await walkGeminiDirectKeys(input)
  return picked?.key ?? null
}

export async function reserveGeminiDirectKey(input: {
  estimateMicroUsd: number
  exclude?: ReadonlySet<string>
  now?: number
  allowCooldown?: boolean
}): Promise<{ key: GeminiDirectKey; reservationId: string } | null> {
  const picked = await walkGeminiDirectKeys({ ...input, reserve: true })
  if (!picked?.reservationId) return null
  return { key: picked.key, reservationId: picked.reservationId }
}

export async function releaseGeminiDirectKeyReservation(id: string): Promise<void> {
  await releaseGeminiReservation(id)
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
    .insert(schema.gemini_direct_key_state)
    .values({
      fingerprint,
      disabled_reason: set.disabled_reason ?? null,
      cooldown_until: set.cooldown_until ?? null,
      last_error: set.last_error,
      last_error_at: set.last_error_at,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: schema.gemini_direct_key_state.fingerprint,
      set: {
        ...(set.disabled_reason !== undefined ? { disabled_reason: set.disabled_reason } : {}),
        ...(set.cooldown_until !== undefined ? { cooldown_until: set.cooldown_until } : {}),
        last_error: set.last_error,
        last_error_at: set.last_error_at,
        updated_at: now,
      },
    })
}

export async function markGeminiKeyDisabled(
  key: GeminiDirectKey,
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
      { event: 'gemini.direct_key_disable_failed', err, fingerprint: key.label },
      'failed to persist gemini key disable',
    )
  }
}

export async function markGeminiKeyCooldown(key: GeminiDirectKey, error: unknown): Promise<void> {
  const now = Date.now()
  try {
    await writeKeyState(key.fingerprint, {
      cooldown_until: now + config.geminiDirect.cooldownMs,
      last_error: publicError(error),
      last_error_at: now,
    })
  } catch (err) {
    log.warn(
      { event: 'gemini.direct_key_cooldown_failed', err, fingerprint: key.label },
      'failed to persist gemini key cooldown',
    )
  }
}

/** 后台手动恢复一把停用或冷却中的 Gemini 密钥。 */
export async function restoreGeminiDirectKey(
  fingerprint: string,
  operator?: string,
): Promise<boolean> {
  const keys = configuredGeminiDirectKeys()
  const key = keys.find((entry) => entry.fingerprint === fingerprint)
  if (!key) return false
  await db
    .delete(schema.gemini_direct_key_state)
    .where(eq(schema.gemini_direct_key_state.fingerprint, fingerprint))
  forgetGeminiDirectKeyDisabled(fingerprint)
  log.info(
    {
      event: 'gemini.direct_key_restored',
      fingerprint: key.label,
      ...(operator ? { operator } : {}),
    },
    'gemini direct key restored',
  )
  return true
}

function statusOf(
  key: { enabled: boolean },
  row: KeyStateRow | undefined,
  spent: number,
  cap: number,
  now: number,
): GeminiDirectKeyStatus {
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

export async function buildGeminiDirectKeyPanel(
  days: 7 | 30,
  now = Date.now(),
): Promise<GeminiDirectAdminView> {
  let keys: GeminiDirectKey[] = []
  let configProblem: string | null = null
  try {
    keys = configuredGeminiDirectKeys()
  } catch (err) {
    configProblem =
      err instanceof FingerprintSecretMissingError
        ? err.message
        : 'Gemini 直连密钥配置无效，详见服务端日志（gemini.direct_keys_invalid）'
    log.warn(
      { event: 'gemini.direct_keys_invalid', err: err instanceof Error ? err.name : 'error' },
      'gemini direct key config is invalid',
    )
  }
  const state = keys.length > 0 ? await loadKeyState() : new Map<string, KeyStateRow>()
  const dayList = recentTaipeiDays(days, now)
  const windowStart = Date.parse(`${dayList[0]}T00:00:00+08:00`)

  const [keyWindowRows, dayRows, modelRows, revisionRows] = await Promise.all([
    db
      .select({
        key_fingerprint: schema.gemini_direct_usage.key_fingerprint,
        requests: sql<string>`count(*)`,
        succeeded: sql<string>`count(*) filter (where ${schema.gemini_direct_usage.status} = 'ok')`,
        images: sql<string | null>`sum(${schema.gemini_direct_usage.images})`,
        rate_limited: sql<string>`count(*) filter (where ${schema.gemini_direct_usage.status} = 'rate_limited')`,
      })
      .from(schema.gemini_direct_usage)
      .where(gte(schema.gemini_direct_usage.created_at, windowStart))
      .groupBy(schema.gemini_direct_usage.key_fingerprint),
    db
      .select({
        day: sql<string>`to_char(${schema.gemini_direct_usage.created_at} at time zone 'Asia/Taipei', 'YYYY-MM-DD')`,
        requests: sql<string>`count(*)`,
        succeeded: sql<string>`count(*) filter (where ${schema.gemini_direct_usage.status} = 'ok')`,
        images: sql<string | null>`sum(${schema.gemini_direct_usage.images})`,
        rate_limited: sql<string>`count(*) filter (where ${schema.gemini_direct_usage.status} = 'rate_limited')`,
        cost: sql<string | null>`sum(${schema.gemini_direct_usage.cost_micro_usd})`,
      })
      .from(schema.gemini_direct_usage)
      .where(gte(schema.gemini_direct_usage.created_at, windowStart))
      .groupBy(
        sql`to_char(${schema.gemini_direct_usage.created_at} at time zone 'Asia/Taipei', 'YYYY-MM-DD')`,
      ),
    db
      .select({
        model: schema.gemini_direct_usage.model,
        requests: sql<string>`count(*)`,
        succeeded: sql<string>`count(*) filter (where ${schema.gemini_direct_usage.status} = 'ok')`,
        images: sql<string | null>`sum(${schema.gemini_direct_usage.images})`,
        rate_limited: sql<string>`count(*) filter (where ${schema.gemini_direct_usage.status} = 'rate_limited')`,
        cost: sql<string | null>`sum(${schema.gemini_direct_usage.cost_micro_usd})`,
      })
      .from(schema.gemini_direct_usage)
      .where(gte(schema.gemini_direct_usage.created_at, windowStart))
      .groupBy(schema.gemini_direct_usage.model),
    db
      .select({ updated_at: schema.gemini_direct_admin_keys.updated_at })
      .from(schema.gemini_direct_admin_keys),
  ])

  const keyStatsMap = new Map<
    string,
    { requests: number; succeeded: number; images: number; rate_limited: number }
  >()
  let unattributedStats = { requests: 0, succeeded: 0, images: 0, rate_limited: 0 }
  for (const row of keyWindowRows) {
    const entry = {
      requests: Number(row.requests ?? 0),
      succeeded: Number(row.succeeded ?? 0),
      images: Number(row.images ?? 0),
      rate_limited: Number(row.rate_limited ?? 0),
    }
    if (row.key_fingerprint === null) unattributedStats = entry
    else keyStatsMap.set(row.key_fingerprint, entry)
  }

  const views = []
  for (const key of keys) {
    const spent = await geminiKeySpent(key.fingerprint, key.ordinal === 1, now)
    const cap = geminiKeyBudgetCapMicroUsd(key.budgetUsd)
    const row = state.get(key.fingerprint)
    const ks = keyStatsMap.get(key.fingerprint) ?? {
      requests: 0,
      succeeded: 0,
      images: 0,
      rate_limited: 0,
    }
    const extra =
      key.ordinal === 1
        ? unattributedStats
        : { requests: 0, succeeded: 0, images: 0, rate_limited: 0 }
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
      requests: ks.requests + extra.requests,
      succeeded: ks.succeeded + extra.succeeded,
      images: ks.images + extra.images,
      rate_limited: ks.rate_limited + extra.rate_limited,
      cooldown_until: row?.cooldown_until ?? null,
      last_error: displayGeminiKeyError(row?.last_error ?? null),
      last_error_at: row?.last_error_at ?? null,
    })
  }

  const spent = await geminiSpentThisMonth(now)
  const cap = views.reduce((sum, key) => sum + key.budget_micro_usd, 0)
  const byDay = new Map(
    dayRows.map((row) => [
      row.day,
      {
        requests: Number(row.requests ?? 0),
        succeeded: Number(row.succeeded ?? 0),
        images: Number(row.images ?? 0),
        rate_limited: Number(row.rate_limited ?? 0),
        cost: Number(row.cost ?? 0),
      },
    ]),
  )
  const daily = dayList.map((day) => {
    const d = byDay.get(day)
    return {
      day,
      requests: d?.requests ?? 0,
      succeeded: d?.succeeded ?? 0,
      images: d?.images ?? 0,
      rate_limited: d?.rate_limited ?? 0,
      cost_micro_usd: d?.cost ?? 0,
    }
  })
  const by_model = modelRows
    .map((row) => ({
      model: row.model,
      requests: Number(row.requests ?? 0),
      succeeded: Number(row.succeeded ?? 0),
      images: Number(row.images ?? 0),
      rate_limited: Number(row.rate_limited ?? 0),
      cost_micro_usd: Number(row.cost ?? 0),
    }))
    .sort((a, b) => b.cost_micro_usd - a.cost_micro_usd || b.requests - a.requests)

  const window_requests = daily.reduce((sum, d) => sum + d.requests, 0)
  const window_succeeded = daily.reduce((sum, d) => sum + d.succeeded, 0)
  const window_images = daily.reduce((sum, d) => sum + d.images, 0)
  const window_rate_limited = daily.reduce((sum, d) => sum + d.rate_limited, 0)
  const window_cost_micro_usd = daily.reduce((sum, d) => sum + d.cost_micro_usd, 0)

  const master = readMasterKey()
  const source = adminGeminiDirectKeys() === null ? 'env' : 'admin'
  return {
    generated_at: now,
    currency_note: 'estimated',
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
    window_requests,
    window_succeeded,
    window_images,
    window_rate_limited,
    window_cost_micro_usd,
    daily,
    by_model,
  }
}
