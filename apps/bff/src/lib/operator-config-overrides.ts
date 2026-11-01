import { randomUUID } from 'node:crypto'
import {
  CAPABILITIES,
  type CapabilityKey,
  OPERATOR_REGISTRY,
  type OperatorRegistryEntry,
  QUOTAS,
  type QuotaKey,
} from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { baselineOperatorConfig, config, setEffectiveOperatorConfig } from '../config'
import { db, schema } from '../db/client'
import { log } from './logger'
import { type ResolvedOperatorConfig, validateOperatorConfigValues } from './operator-config'

export type OperatorOverrideValue = boolean | number
const invalidOverrideReasons = new Map<string, string>()
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

async function rows() {
  return db.select().from(schema.operator_config_overrides)
}

function rowView(
  effectiveBase: ResolvedOperatorConfig,
  baselineBase: ResolvedOperatorConfig,
  row: typeof schema.operator_config_overrides.$inferSelect | undefined,
  key: string,
): OperatorOverrideView {
  const metadata = OPERATOR_REGISTRY[key]
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
  if (!sameValue(row.baseline_value, baseline)) {
    return {
      key,
      kind: metadata.kind,
      metadata,
      baseline,
      effective: baseline,
      override: rowOverride(row),
      valid: false,
      invalidReason: 'baseline_changed',
    }
  }
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
    effective: row.value,
    override: rowOverride(row),
    valid: true,
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
    baselineChanged: view.invalidReason === 'baseline_changed',
    invalid: !view.valid && view.invalidReason !== 'baseline_changed',
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
  const effectiveBase = config.operator
  const baselineBase = baselineOperatorConfig()
  const allRows = await rows()
  const byKey = new Map(allRows.map((row) => [row.key, row]))
  const views = Object.keys(OPERATOR_REGISTRY).map((key) =>
    rowView(effectiveBase, baselineBase, byKey.get(key), key),
  )
  for (const row of allRows) {
    if (!OPERATOR_REGISTRY[row.key]) views.push(rowView(effectiveBase, baselineBase, row, row.key))
  }
  const [state] = await db
    .select({ revision: schema.operator_config_state.revision })
    .from(schema.operator_config_state)
    .where(eq(schema.operator_config_state.id, 1))
    .limit(1)
  const globalRevision = state?.revision ?? 0
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
  if (metadata.kind === 'capability' && value === true) {
    for (const dependency of metadata.dependencies) {
      if (!base.capabilities[dependency as CapabilityKey]) {
        throw new OperatorConfigError(409, 'dependency_or_derived_rejected', {
          rule: `${key} requires ${dependency}`,
        })
      }
    }
  }
  const capabilities = { ...base.capabilities }
  const quotas = { ...base.quotas }
  if (metadata.kind === 'capability') capabilities[key as CapabilityKey] = value as boolean
  else quotas[key as QuotaKey] = value as number
  try {
    const effective = validateOperatorConfigValues(base, capabilities, quotas)
    if (!Object.is(valueFor(effective, key), value)) {
      throw new OperatorConfigError(409, 'dependency_or_derived_rejected', {
        rule: `${key} was forced off by derived configuration`,
      })
    }
    return effective
  } catch (error) {
    if (error instanceof OperatorConfigError) throw error
    const message = error instanceof Error ? error.message : String(error)
    const rule = message.match(/^([^ ]+)/)?.[1] ?? 'derived_config'
    throw new OperatorConfigError(409, 'dependency_or_derived_rejected', { rule, message })
  }
}

export async function setOperatorConfig(input: {
  key: string
  value: unknown
  expectedRevision: number
  operatorId: string
  reason: unknown
}): Promise<OperatorOverrideView> {
  const metadata = OPERATOR_REGISTRY[input.key]
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
    derive(config.operator, input.key, overrideValue)
    const [state] = await tx
      .select({ revision: schema.operator_config_state.revision })
      .from(schema.operator_config_state)
      .where(eq(schema.operator_config_state.id, 1))
      .limit(1)
    const currentRevision = state?.revision ?? 0
    if (input.expectedRevision !== currentRevision)
      throw new OperatorConfigError(409, 'stale_revision', { currentRevision })
    const [row] = await tx
      .select()
      .from(schema.operator_config_overrides)
      .where(eq(schema.operator_config_overrides.key, input.key))
      .limit(1)
    const before = row?.value ?? valueFor(baselineOperatorConfig(), input.key)
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
  const metadata = OPERATOR_REGISTRY[input.key]
  if (!metadata) throw new OperatorConfigError(404, 'unknown_key')
  if (metadata.editability !== 'hot')
    throw new OperatorConfigError(
      409,
      metadata.editability === 'boot' ? 'boot_time_only' : 'read_only',
    )
  const reason = normalizeReason(input.reason)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
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
    const [row] = await tx
      .select()
      .from(schema.operator_config_overrides)
      .where(eq(schema.operator_config_overrides.key, input.key))
      .limit(1)
    if (!row) throw new OperatorConfigError(409, 'stale_revision', { currentRevision })
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

async function refreshOperatorConfigUnlocked(): Promise<number> {
  invalidOverrideReasons.clear()
  const base = baselineOperatorConfig()
  const allRows = await rows()
  const knownRows = allRows.filter((row) => {
    const metadata = OPERATOR_REGISTRY[row.key]
    if (!metadata || !isValue(metadata, row.value)) {
      invalidOverrideReasons.set(row.key, 'invalid_value')
      log.error(
        { event: 'operator_config.invalid_override', key: row.key, revision: row.revision },
        'ignoring invalid operator override',
      )
      return false
    }
    if (!sameValue(row.baseline_value, valueFor(base, row.key))) {
      invalidOverrideReasons.set(row.key, 'baseline_changed')
      log.warn(
        { event: 'operator_config.baseline_changed', key: row.key, revision: row.revision },
        'ignoring override from an older baseline',
      )
      return false
    }
    return true
  })
  const accepted = new Map(knownRows.map((row) => [row.key, row]))
  let revision = 0
  for (const row of allRows) revision = Math.max(revision, row.revision)
  while (true) {
    const capabilities = { ...base.capabilities }
    const quotas = { ...base.quotas }
    for (const row of accepted.values()) {
      const metadata = OPERATOR_REGISTRY[row.key]!
      if (metadata.kind === 'capability')
        capabilities[row.key as CapabilityKey] = row.value as boolean
      else quotas[row.key as QuotaKey] = row.value as number
    }
    try {
      const effective = validateOperatorConfigValues(base, capabilities, quotas)
      const forcedOff = [...accepted.values()].find(
        (row) => valueFor(effective, row.key) !== row.value,
      )
      if (forcedOff) {
        accepted.delete(forcedOff.key)
        invalidOverrideReasons.set(forcedOff.key, 'invalid_combination')
        log.error(
          { event: 'operator_config.invalid_override', key: forcedOff.key },
          'ignoring operator override forced off by derived configuration',
        )
        continue
      }
      setEffectiveOperatorConfig(effective)
      break
    } catch (error) {
      const invalid = accepted.keys().next().value as string | undefined
      if (!invalid) {
        log.error(
          { event: 'operator_config.reload_failed', err: error },
          'baseline operator configuration became invalid',
        )
        setEffectiveOperatorConfig(base)
        break
      }
      accepted.delete(invalid)
      invalidOverrideReasons.set(invalid, 'invalid_combination')
      log.error(
        { event: 'operator_config.invalid_override', key: invalid },
        'ignoring operator override that invalidates the effective configuration',
      )
    }
  }
  lastLoadedRevision = revision
  return revision
}
export function refreshOperatorConfig(): Promise<number> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = refreshOperatorConfigUnlocked().finally(() => {
    refreshInFlight = undefined
  })
  return refreshInFlight
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
