import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import {
  assertSecretMaterial,
  openSecret,
  readMasterKey,
  sealSecret,
  UpstreamSecretError,
} from '../upstream-secrets'
import {
  adminGeminiDirectKeys,
  type GeminiDirectKey,
  geminiFingerprintOf,
  safeEnvGeminiDirectKeys,
  setAdminGeminiDirectKeySnapshot,
} from './gemini-key-config'
import { fingerprintMacSource } from './gpt-direct-availability'
import { FingerprintSecretMissingError } from './gpt-key-config'

/**
 * 后台 Gemini 直连密钥池的加密存储、刷新与 CRUD。
 * 复用 upstream-secrets 主密钥，使用独立 AAD 前缀 `gemini-direct:`。
 */

const AAD_PREFIX = 'gemini-direct:'

function aad(id: string): string {
  return `${AAD_PREFIX}${id}`
}

function operatorIdOf(value: string | null | undefined): string {
  return (value?.trim() || 'admin').slice(0, 200)
}

function assertBudgetUsd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1_000_000) {
    throw new UpstreamSecretError('invalid_budget', 400, '月预算必须是正整数')
  }
  return value
}

function sealedRow(row: { nonce: string; tag: string; ciphertext: string }) {
  return { nonce: row.nonce, tag: row.tag, ciphertext: row.ciphertext }
}

let refreshRequested = 0
let refreshChain: Promise<void> = Promise.resolve()
let cachedRevision: string | undefined
let cachedMasterKey: Buffer | undefined
let cachedFingerprintSecret: string | undefined
let cachedKeys: GeminiDirectKey[] | undefined

export function refreshGeminiDirectKeys(): Promise<void> {
  const ticket = ++refreshRequested
  const run = refreshChain.then(
    () => refreshGeminiDirectKeysOnce(ticket),
    () => refreshGeminiDirectKeysOnce(ticket),
  )
  refreshChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function publishSnapshot(admin: GeminiDirectKey[] | null): Promise<void> {
  const states = await db
    .select()
    .from(schema.gemini_direct_key_state)
    .catch((error) => {
      setAdminGeminiDirectKeySnapshot(
        admin,
        new Set((admin ?? safeEnvGeminiDirectKeys()).map((key) => key.fingerprint)),
      )
      throw error
    })
  const hardDisabled = new Set(
    states.filter((row) => row.disabled_reason !== null).map((row) => row.fingerprint),
  )
  setAdminGeminiDirectKeySnapshot(admin, hardDisabled)
}

async function refreshGeminiDirectKeysOnce(ticket: number): Promise<void> {
  if (ticket !== refreshRequested) return
  const fingerprintSource = fingerprintMacSource()
  const fingerprintSecret = fingerprintSource === 'unset' ? '' : process.env[fingerprintSource]
  if (fingerprintSource === 'unset') {
    cachedRevision = undefined
    try {
      const [row] = await db
        .select({ id: schema.gemini_direct_admin_keys.id })
        .from(schema.gemini_direct_admin_keys)
        .limit(1)
      if (ticket !== refreshRequested) return
      setAdminGeminiDirectKeySnapshot(row ? [] : null, new Set())
    } catch (err) {
      log.warn(
        {
          event: 'gemini.direct_admin_key_refresh_failed',
          err: err instanceof Error ? err.name : 'error',
        },
        'admin gemini direct key refresh failed',
      )
    }
    return
  }
  const master = readMasterKey()
  if (!master.ok) {
    cachedRevision = undefined
    try {
      const [row] = await db
        .select({ id: schema.gemini_direct_admin_keys.id })
        .from(schema.gemini_direct_admin_keys)
        .limit(1)
      if (ticket !== refreshRequested) return
      if (row) {
        log.warn(
          { event: 'gemini.direct_admin_key_unavailable', reason: master.code },
          'admin gemini direct keys exist but the master key cannot open them',
        )
        setAdminGeminiDirectKeySnapshot([], new Set())
        return
      }
      await publishSnapshot(null)
    } catch (err) {
      log.warn(
        {
          event: 'gemini.direct_admin_key_refresh_failed',
          err: err instanceof Error ? err.name : 'error',
        },
        'admin gemini direct key refresh failed',
      )
    }
    return
  }
  try {
    const [version] = await db.execute<{ revision: string }>(sql`
      SELECT md5(COALESCE(jsonb_agg(to_jsonb(keys) ORDER BY keys.id)::text, '[]')) AS revision
      FROM ${schema.gemini_direct_admin_keys} AS keys
    `)
    if (ticket !== refreshRequested) return
    if (
      version?.revision === cachedRevision &&
      cachedMasterKey?.equals(master.key) &&
      fingerprintSecret === cachedFingerprintSecret &&
      cachedKeys
    ) {
      await publishSnapshot(cachedKeys)
      return
    }
    const rows = await db
      .select()
      .from(schema.gemini_direct_admin_keys)
      .orderBy(asc(schema.gemini_direct_admin_keys.ordinal))
    if (ticket !== refreshRequested) return
    if (rows.length === 0) {
      await publishSnapshot(null)
      cachedRevision = version?.revision
      cachedMasterKey = master.key
      cachedFingerprintSecret = fingerprintSecret
      cachedKeys = undefined
      return
    }
    const keys: GeminiDirectKey[] = []
    let ignored = 0
    for (const row of rows) {
      const secret = openSecret(aad(row.id), sealedRow(row))
      if (!secret) {
        ignored += 1
        continue
      }
      const fingerprint = geminiFingerprintOf(secret)
      if (fingerprint.fingerprint !== row.fingerprint) {
        ignored += 1
        continue
      }
      keys.push({
        id: row.id,
        ordinal: row.ordinal,
        secret,
        budgetUsd: row.budget_usd,
        enabled: row.enabled,
        ...fingerprint,
      })
    }
    if (ignored > 0) {
      log.warn(
        { event: 'gemini.direct_admin_key_decrypt_failed', ignored },
        'some admin gemini direct keys could not be decrypted',
      )
    }
    if (ticket !== refreshRequested) return
    if (keys.length === 0) {
      setAdminGeminiDirectKeySnapshot([], new Set())
      return
    }
    await publishSnapshot(keys)
    cachedRevision = version?.revision
    cachedMasterKey = master.key
    cachedFingerprintSecret = fingerprintSecret
    cachedKeys = keys
  } catch (err) {
    cachedRevision = undefined
    if (adminGeminiDirectKeys() !== null) {
      // 刷新失败时不能继续放行可能已停用/删除/降额的旧后台快照，也不能静默回退到环境变量。
      setAdminGeminiDirectKeySnapshot([], new Set())
    }
    log.warn(
      {
        event: 'gemini.direct_admin_key_refresh_failed',
        err: err instanceof Error ? err.name : 'error',
      },
      'admin gemini direct key refresh failed',
    )
  }
}

export function _resetGeminiDirectAdminCacheForTesting(): void {
  cachedRevision = undefined
  cachedMasterKey = undefined
  cachedFingerprintSecret = undefined
  cachedKeys = undefined
}

function audit(
  operatorId: string,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
  createdAt: number,
) {
  return {
    id: randomUUID(),
    operator_id: operatorId,
    action,
    target_type: 'gemini_direct_key',
    target_id: targetId,
    details,
    created_at: createdAt,
  }
}

function uniqueViolation(error: unknown): boolean {
  const errno = (error as { cause?: { errno?: unknown } } | null)?.cause?.errno
  return String(errno ?? '') === '23505' || String(error).includes('23505')
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function nextMonotonicRevision(tx: DbTx): Promise<number> {
  const rows = await tx
    .select({ updated_at: schema.gemini_direct_admin_keys.updated_at })
    .from(schema.gemini_direct_admin_keys)
  const maxUpdatedAt = rows.reduce((max, row) => Math.max(max, row.updated_at), 0)
  return Math.max(Date.now(), maxUpdatedAt + 1)
}

export async function createGeminiDirectKey(input: {
  apiKey: unknown
  budgetUsd: unknown
  operatorId: string | null
}): Promise<void> {
  const secret = assertSecretMaterial(input.apiKey)
  const budgetUsd = assertBudgetUsd(input.budgetUsd)
  let fingerprint: ReturnType<typeof geminiFingerprintOf>
  try {
    fingerprint = geminiFingerprintOf(secret)
  } catch (error) {
    if (error instanceof FingerprintSecretMissingError) {
      throw new UpstreamSecretError('fingerprint_secret_missing', 503, error.message)
    }
    throw error
  }
  const id = randomUUID()
  const sealed = sealSecret(aad(id), secret)
  const operatorId = operatorIdOf(input.operatorId)
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gemini-direct-admin-keys'))`)
      const now = await nextMonotonicRevision(tx)
      const [maxRow] = await tx
        .select({
          value: sql<number>`coalesce(max(${schema.gemini_direct_admin_keys.ordinal}), 0)`,
        })
        .from(schema.gemini_direct_admin_keys)
      const ordinal = Number(maxRow?.value ?? 0) + 1
      await tx.insert(schema.gemini_direct_admin_keys).values({
        id,
        ordinal,
        fingerprint: fingerprint.fingerprint,
        budget_usd: budgetUsd,
        enabled: true,
        ...sealed,
        updated_at: now,
        updated_by: operatorId,
      })
      await tx.insert(schema.operator_audits).values(
        audit(
          operatorId,
          'gemini_direct_key.create',
          id,
          {
            fingerprint: fingerprint.label,
            ordinal,
            budget_usd: budgetUsd,
          },
          now,
        ),
      )
    })
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new UpstreamSecretError('duplicate_key', 409, '这把密钥已经在列表里')
    }
    throw error
  }
  await refreshGeminiDirectKeys()
}

export async function updateGeminiDirectKey(input: {
  id: string
  budgetUsd?: unknown
  enabled?: unknown
  operatorId: string | null
}): Promise<void> {
  if (input.budgetUsd === undefined && input.enabled === undefined) {
    throw new UpstreamSecretError('invalid_budget', 400, '没有要改的内容')
  }
  const budgetUsd = input.budgetUsd === undefined ? undefined : assertBudgetUsd(input.budgetUsd)
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new UpstreamSecretError('invalid_budget', 400, '启用状态无效')
  }
  const [row] = await db
    .select()
    .from(schema.gemini_direct_admin_keys)
    .where(eq(schema.gemini_direct_admin_keys.id, input.id))
  if (!row) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gemini-direct-admin-keys'))`)
    const now = await nextMonotonicRevision(tx)
    const updated = await tx
      .update(schema.gemini_direct_admin_keys)
      .set({
        ...(budgetUsd !== undefined ? { budget_usd: budgetUsd } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        updated_at: now,
        updated_by: operatorId,
      })
      .where(eq(schema.gemini_direct_admin_keys.id, row.id))
      .returning({ id: schema.gemini_direct_admin_keys.id })
    if (updated.length === 0) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
    await tx.insert(schema.operator_audits).values(
      audit(
        operatorId,
        'gemini_direct_key.update',
        row.id,
        {
          fingerprint: row.fingerprint,
          ...(budgetUsd !== undefined ? { budget_usd: budgetUsd } : {}),
          ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        },
        now,
      ),
    )
  })
  await refreshGeminiDirectKeys()
}

export async function reorderGeminiDirectKeys(input: {
  ids: readonly string[]
  revision: number
  operatorId: string | null
}): Promise<void> {
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gemini-direct-admin-keys'))`)
    const rows = await tx
      .select({
        id: schema.gemini_direct_admin_keys.id,
        updated_at: schema.gemini_direct_admin_keys.updated_at,
      })
      .from(schema.gemini_direct_admin_keys)
    const revision = rows.reduce((max, row) => Math.max(max, row.updated_at), 0)
    if (revision !== input.revision) {
      throw new UpstreamSecretError('stale_revision', 409, '顺序已变化')
    }
    const known = new Set(rows.map((row) => row.id))
    if (
      input.ids.length !== known.size ||
      input.ids.some((id) => !known.has(id)) ||
      new Set(input.ids).size !== input.ids.length
    ) {
      throw new UpstreamSecretError('invalid_order', 400, '顺序不完整')
    }
    const now = Math.max(Date.now(), revision + 1)
    for (const [index, id] of input.ids.entries()) {
      await tx
        .update(schema.gemini_direct_admin_keys)
        .set({ ordinal: index + 1, updated_at: now, updated_by: operatorId })
        .where(eq(schema.gemini_direct_admin_keys.id, id))
    }
    await tx
      .insert(schema.operator_audits)
      .values(audit(operatorId, 'gemini_direct_key.reorder', 'order', { ids: [...input.ids] }, now))
  })
  await refreshGeminiDirectKeys()
}

export async function deleteGeminiDirectKey(input: {
  id: string
  operatorId: string | null
}): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.gemini_direct_admin_keys)
    .where(eq(schema.gemini_direct_admin_keys.id, input.id))
  if (!row) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gemini-direct-admin-keys'))`)
    const now = await nextMonotonicRevision(tx)
    const removed = await tx
      .delete(schema.gemini_direct_admin_keys)
      .where(eq(schema.gemini_direct_admin_keys.id, row.id))
      .returning({ id: schema.gemini_direct_admin_keys.id })
    if (removed.length === 0) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
    const [remaining] = await tx
      .select({ id: schema.gemini_direct_admin_keys.id })
      .from(schema.gemini_direct_admin_keys)
      .orderBy(asc(schema.gemini_direct_admin_keys.ordinal))
      .limit(1)
    if (remaining) {
      await tx
        .update(schema.gemini_direct_admin_keys)
        .set({ updated_at: now })
        .where(eq(schema.gemini_direct_admin_keys.id, remaining.id))
    }
    await tx
      .delete(schema.gemini_direct_key_state)
      .where(eq(schema.gemini_direct_key_state.fingerprint, row.fingerprint))
    await tx
      .insert(schema.operator_audits)
      .values(
        audit(
          operatorId,
          'gemini_direct_key.delete',
          row.id,
          { fingerprint: row.fingerprint },
          now,
        ),
      )
  })
  await refreshGeminiDirectKeys()
}
