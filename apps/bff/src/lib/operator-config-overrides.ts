import { randomUUID } from 'node:crypto'
import {
  CAPABILITIES,
  type CapabilityKey,
  OPERATOR_REGISTRY,
  type OperatorRegistryEntry,
  QUOTAS,
  type QuotaKey,
} from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'
import { baselineOperatorConfig, config, setEffectiveOperatorConfig } from '../config'
import { db, schema } from '../db/client'
import { type AlertSender, createAlertSenderFromEnv } from '../ops/alert-sender'
import { log } from './logger'
import { type ResolvedOperatorConfig, validateOperatorConfigValues } from './operator-config'

export type OperatorOverrideValue = boolean | number
let invalidOverrideReasons = new Map<string, string>()
let lastLoadedRevision = -1
let refreshInFlight: Promise<number> | undefined
export interface OperatorOverrideView {
  readonly key: string
  readonly kind?: 'capability' | 'quota'
  readonly metadata?: OperatorRegistryEntry
  readonly baseline: OperatorOverrideValue | undefined
  readonly effective: OperatorOverrideValue | undefined
  readonly override?: {
    readonly value: OperatorOverrideValue
    readonly revision: number
    readonly baselineValue: unknown
    readonly operatorId: string
    readonly reason: string
    readonly updatedAt: number
  }
  readonly valid: boolean
  readonly invalidReason?: string
}

function valueFor(base: ResolvedOperatorConfig, key: string): OperatorOverrideValue | undefined {
  if (Object.hasOwn(CAPABILITIES, key)) return base.capabilities[key as CapabilityKey]
  if (Object.hasOwn(QUOTAS, key)) return base.quotas[key as QuotaKey]
  return undefined
}

function isValue(entry: OperatorRegistryEntry, value: unknown): value is OperatorOverrideValue {
  if (entry.kind === 'capability') return typeof value === 'boolean'
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= (entry.min ?? 0) &&
    value <= (entry.max ?? Number.MAX_SAFE_INTEGER)
  )
}

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === 'number' && typeof b === 'number' ? Object.is(a, b) : a === b
}

type OverrideRow = typeof schema.operator_config_overrides.$inferSelect

async function readSnapshot() {
  return db.transaction(
    async (tx) => {
      const [state] = await tx
        .select()
        .from(schema.operator_config_state)
        .where(eq(schema.operator_config_state.id, 1))
        .limit(1)
      const rows = await tx.select().from(schema.operator_config_overrides)
      return { rows, revision: state?.revision ?? 0 }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

function rowView(
  effectiveBase: ResolvedOperatorConfig,
  baselineBase: ResolvedOperatorConfig,
  row: typeof schema.operator_config_overrides.$inferSelect | undefined,
  key: string,
): OperatorOverrideView {
  const metadata = Object.hasOwn(OPERATOR_REGISTRY, key) ? OPERATOR_REGISTRY[key] : undefined
  const baseline = valueFor(baselineBase, key)
  const effective = valueFor(effectiveBase, key)
  const invalidReason = invalidOverrideReasons.get(key)
  if (!metadata) {
    return {
      key,
      baseline,
      effective,
      valid: false,
      invalidReason: invalidReason ?? 'unknown_key',
      ...(row ? { override: rowOverride(row) } : {}),
    }
  }
  if (!row) return { key, kind: metadata.kind, metadata, baseline, effective, valid: true }
  const baselineChanged = !sameValue(row.baseline_value, baseline)
  if (!isValue(metadata, row.value) || invalidReason) {
    return {
      key,
      kind: metadata.kind,
      metadata,
      baseline,
      effective,
      override: rowOverride(row),
      valid: false,
      invalidReason: invalidReason ?? 'invalid_value',
    }
  }
  return {
    key,
    kind: metadata.kind,
    metadata,
    baseline,
    effective,
    override: rowOverride(row),
    valid: true,
    ...(baselineChanged ? { invalidReason: 'baseline_changed' } : {}),
  }
}

interface AdminOperatorSetting {
  readonly key: string
  readonly kind: 'capability' | 'quota'
  readonly name: string
  readonly description: string
  readonly domain: string
  readonly editability: 'hot' | 'boot-time' | 'read-only'
  readonly risk: boolean
  readonly baseline: OperatorOverrideValue
  readonly override: OperatorOverrideValue | null
  readonly effective: OperatorOverrideValue
  readonly reason: string | null
  readonly revision: number
  readonly updatedAt: number | null
  readonly unit?: string
  readonly min?: number
  readonly max?: number
  readonly dependencies: readonly string[]
  readonly baselineChanged: boolean
  readonly invalid: boolean
  readonly invalidReason: string | null
}

function adminSetting(view: OperatorOverrideView): AdminOperatorSetting {
  const metadata = view.metadata
  return {
    key: view.key,
    kind: view.kind ?? 'quota',
    name: metadata?.name ?? view.key,
    description: metadata?.description ?? '',
    domain: metadata?.group ?? 'other',
    editability:
      metadata?.editability === 'boot' ? 'boot-time' : (metadata?.editability ?? 'read-only'),
    risk: metadata?.risk === 'high',
    baseline: view.baseline ?? false,
    override: view.override?.value ?? null,
    effective: view.effective ?? view.baseline ?? false,
    reason: view.override?.reason ?? null,
    revision: view.override?.revision ?? 0,
    updatedAt: view.override?.updatedAt ?? null,
    unit: metadata?.unit,
    min: metadata?.min,
    max: metadata?.max,
    dependencies: metadata?.dependencies ?? [],
    baselineChanged: !!view.override && !sameValue(view.override.baselineValue, view.baseline),
    invalid: !view.valid,
    invalidReason: view.invalidReason ?? null,
  }
}

function rowOverride(row: typeof schema.operator_config_overrides.$inferSelect) {
  return {
    value: row.value as OperatorOverrideValue,
    revision: row.revision,
    baselineValue: row.baseline_value,
    operatorId: row.operator_id,
    reason: row.reason,
    updatedAt: row.updated_at,
  }
}

export interface OperatorSettingsResult {
  readonly revision: number
  readonly settings: AdminOperatorSetting[]
}

export async function listOperatorConfig(): Promise<OperatorSettingsResult> {
  await refreshOperatorConfig()
  const effectiveBase = config.operator
  const baselineBase = baselineOperatorConfig()
  const allRows = loadedRows
  const byKey = new Map(allRows.map((row) => [row.key, row]))
  const views = Object.keys(OPERATOR_REGISTRY).map((key) =>
    rowView(effectiveBase, baselineBase, byKey.get(key), key),
  )
  for (const row of allRows) {
    if (!Object.hasOwn(OPERATOR_REGISTRY, row.key))
      views.push(rowView(effectiveBase, baselineBase, row, row.key))
  }
  const globalRevision = lastLoadedRevision
  return {
    revision: globalRevision,
    settings: views.map((view) => ({ ...adminSetting(view), revision: globalRevision })),
  }
}

function normalizeReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim())
    throw new OperatorConfigError(400, 'reason_required')
  if (reason.trim().length > 1000) throw new OperatorConfigError(400, 'reason_too_long')
  return reason.trim()
}

export class OperatorConfigError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
  }
}

function derive(base: ResolvedOperatorConfig, key: string, value: OperatorOverrideValue) {
  const metadata = OPERATOR_REGISTRY[key]
  if (!metadata) throw new OperatorConfigError(404, 'unknown_key')
  const capabilities = { ...base.capabilities }
  const quotas = { ...base.quotas }
  if (metadata.kind === 'capability') capabilities[key as CapabilityKey] = value as boolean
  else quotas[key as QuotaKey] = value as number
  try {
    for (const [capability, enabled] of Object.entries(capabilities)) {
      if (!enabled) continue
      for (const dependency of OPERATOR_REGISTRY[capability]!.dependencies) {
        if (!capabilities[dependency as CapabilityKey])
          throw new Error(`${capability} requires ${dependency}`)
      }
    }
    const effective = validateOperatorConfigValues(base, capabilities, quotas, config)
    for (const capability of Object.keys(capabilities) as CapabilityKey[]) {
      if (effective.capabilities[capability] !== capabilities[capability])
        throw new Error(`${capability} was forced off by derived configuration`)
    }
    return effective
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new OperatorConfigError(409, 'dependency_or_derived_rejected', {
      rule: message,
      message,
    })
  }
}

// Apply in commit order, retrying prerequisites supplied by a later row. A failing row never
// evicts an unrelated accepted override. This also makes direct DB repairs deterministic.
function resolveRows(base: ResolvedOperatorConfig, rows: OverrideRow[]) {
  let effective = base
  const invalid = new Map<string, string>()
  let pending = rows
    .filter((row) => {
      const entry = Object.hasOwn(OPERATOR_REGISTRY, row.key)
        ? OPERATOR_REGISTRY[row.key]
        : undefined
      const reason = !entry
        ? 'unknown_key'
        : entry.editability !== 'hot'
          ? 'not_hot'
          : !isValue(entry, row.value)
            ? 'invalid_value'
            : undefined
      if (reason) invalid.set(row.key, reason)
      return !reason
    })
    .sort((a, b) => a.revision - b.revision || a.key.localeCompare(b.key))
  while (pending.length) {
    const rejected: OverrideRow[] = []
    for (const row of pending) {
      try {
        effective = derive(effective, row.key, row.value as OperatorOverrideValue)
      } catch (error) {
        if (!(error instanceof OperatorConfigError)) throw error
        rejected.push(row)
      }
    }
    if (rejected.length === pending.length) {
      for (const row of rejected) invalid.set(row.key, 'invalid_combination')
      break
    }
    pending = rejected
  }
  return { effective, invalid }
}

export async function setOperatorConfig(input: {
  key: string
  value: unknown
  expectedRevision: number
  operatorId: string
  reason: unknown
}): Promise<OperatorOverrideView> {
  const metadata = Object.hasOwn(OPERATOR_REGISTRY, input.key)
    ? OPERATOR_REGISTRY[input.key]
    : undefined
  if (!metadata) throw new OperatorConfigError(404, 'unknown_key')
  if (metadata.editability !== 'hot')
    throw new OperatorConfigError(
      409,
      metadata.editability === 'boot' ? 'boot_time_only' : 'read_only',
    )
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new OperatorConfigError(400, 'revision_required')
  const reason = normalizeReason(input.reason)
  if (!isValue(metadata, input.value)) {
    throw new OperatorConfigError(400, 'value_out_of_range', {
      min: metadata.min ?? 0,
      max: metadata.max ?? Number.MAX_SAFE_INTEGER,
    })
  }
  const overrideValue = input.value as OperatorOverrideValue
  const now = Date.now()
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('operator_config_overrides'))`)
    const base = baselineOperatorConfig()
    const [state] = await tx
      .select({ revision: schema.operator_config_state.revision })
      .from(schema.operator_config_state)
      .where(eq(schema.operator_config_state.id, 1))
      .limit(1)
    const currentRevision = state?.revision ?? 0
    if (input.expectedRevision !== currentRevision)
      throw new OperatorConfigError(409, 'stale_revision', { currentRevision })
    const allRows = await tx.select().from(schema.operator_config_overrides)
    const row = allRows.find((row) => row.key === input.key)
    const current = resolveRows(base, allRows).effective
    derive(current, input.key, overrideValue)
    const before = valueFor(current, input.key)
    const revision = currentRevision + 1
    const values = {
      key: input.key,
      value: input.value,
      revision,
      baseline_value: valueFor(baselineOperatorConfig(), input.key),
      operator_id: input.operatorId,
      reason,
      updated_at: now,
    }
    if (row)
      await tx
        .update(schema.operator_config_overrides)
        .set(values)
        .where(eq(schema.operator_config_overrides.key, input.key))
    else await tx.insert(schema.operator_config_overrides).values(values)
    await tx
      .update(schema.operator_config_state)
      .set({ revision })
      .where(eq(schema.operator_config_state.id, 1))
    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId,
      action: 'operator_config.set',
      target_type: 'operator_config',
      target_id: input.key,
      details: { before, after: input.value, reason, revision },
      created_at: now,
    })
    return { revision }
  })
  await refreshOperatorConfig()
  return rowView(
    config.operator,
    baselineOperatorConfig(),
    {
      key: input.key,
      value: input.value,
      revision: result.revision,
      baseline_value: valueFor(baselineOperatorConfig(), input.key),
      operator_id: input.operatorId,
      reason,
      updated_at: now,
    },
    input.key,
  )
}

export async function clearOperatorConfig(input: {
  key: string
  expectedRevision: number
  operatorId: string
  reason: unknown
}): Promise<void> {
  const metadata = Object.hasOwn(OPERATOR_REGISTRY, input.key)
    ? OPERATOR_REGISTRY[input.key]
    : undefined
  if (!metadata) throw new OperatorConfigError(404, 'unknown_key')
  if (metadata.editability !== 'hot')
    throw new OperatorConfigError(
      409,
      metadata.editability === 'boot' ? 'boot_time_only' : 'read_only',
    )
  const reason = normalizeReason(input.reason)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new OperatorConfigError(400, 'revision_required')
  const now = Date.now()
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('operator_config_overrides'))`)
    const [state] = await tx
      .select({ revision: schema.operator_config_state.revision })
      .from(schema.operator_config_state)
      .where(eq(schema.operator_config_state.id, 1))
      .limit(1)
    const currentRevision = state?.revision ?? 0
    if (input.expectedRevision !== currentRevision)
      throw new OperatorConfigError(409, 'stale_revision', { currentRevision })
    const allRows = await tx.select().from(schema.operator_config_overrides)
    const row = allRows.find((row) => row.key === input.key)
    if (!row) throw new OperatorConfigError(409, 'stale_revision', { currentRevision })
    const base = baselineOperatorConfig()
    const current = resolveRows(base, allRows).effective
    derive(current, input.key, valueFor(base, input.key)!)
    await tx
      .delete(schema.operator_config_overrides)
      .where(eq(schema.operator_config_overrides.key, input.key))
    await tx
      .update(schema.operator_config_state)
      .set({ revision: currentRevision + 1 })
      .where(eq(schema.operator_config_state.id, 1))
    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: input.operatorId,
      action: 'operator_config.clear',
      target_type: 'operator_config',
      target_id: input.key,
      details: {
        before: row.value,
        after: valueFor(baselineOperatorConfig(), input.key),
        reason,
        revision: currentRevision + 1,
      },
      created_at: now,
    })
  })
  await refreshOperatorConfig()
}

let loadedRows: OverrideRow[] = []
let alertSender: AlertSender = createAlertSenderFromEnv({
  deployment: process.env.OPS_DEPLOYMENT_NAME?.trim() || 'deployment',
  onPartialFailure: (error) =>
    log.warn({ event: 'ops.alert_target_failed', err: error.message }, 'an alert target failed'),
})

export function setOperatorConfigAlertSenderForTesting(sender: AlertSender): void {
  alertSender = sender
}

async function refreshOperatorConfigUnlocked(): Promise<number> {
  const snapshot = await readSnapshot()
  const base = baselineOperatorConfig()
  validateOperatorConfigValues(base, base.capabilities, base.quotas, config)
  const { effective, invalid } = resolveRows(base, snapshot.rows)
  const previous = invalidOverrideReasons
  // Publish only after reading and validating the complete snapshot; failures retain old state.
  setEffectiveOperatorConfig(effective)
  invalidOverrideReasons = invalid
  loadedRows = snapshot.rows
  lastLoadedRevision = snapshot.revision
  for (const [key, reason] of invalid) {
    if (reason === 'unknown_key' || previous.get(key) === reason) continue
    log.error(
      { event: 'operator_config.invalid_override', key, reason, revision: snapshot.revision },
      'ignoring invalid operator override; using baseline',
    )
    try {
      await alertSender([
        {
          rule: 'operator-config',
          kind: 'firing',
          text: `运营覆盖 ${key} 无效（${reason}），已退回基线配置`,
          detail: { key, reason, revision: snapshot.revision },
        },
      ])
    } catch (error) {
      log.error(
        { event: 'operator_config.alert_failed', err: error },
        'operator config alert failed',
      )
    }
  }
  return snapshot.revision
}

export function refreshOperatorConfig(): Promise<number> {
  // Queue explicit reloads: a writer must not join a refresh begun before its commit.
  const next = (refreshInFlight ?? Promise.resolve(0))
    .catch(() => 0)
    .then(refreshOperatorConfigUnlocked)
  refreshInFlight = next
  void next
    .finally(() => {
      if (refreshInFlight === next) refreshInFlight = undefined
    })
    .catch(() => {})
  return next
}

export async function refreshOperatorConfigIfChanged(): Promise<number | null> {
  const revision = await operatorConfigRevision()
  if (revision === lastLoadedRevision) return null
  return refreshOperatorConfig()
}

export function operatorConfigRevision(): Promise<number> {
  return db
    .select({ revision: schema.operator_config_state.revision })
    .from(schema.operator_config_state)
    .where(eq(schema.operator_config_state.id, 1))
    .limit(1)
    .then(([state]) => state?.revision ?? 0)
}
