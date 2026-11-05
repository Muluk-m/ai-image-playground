import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
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
  adminDirectKeys,
  type DirectKey,
  fingerprintOf,
  noteDirectKeySnapshot,
  resetAdminDirectKeySnapshot,
} from './gpt-key-config'

/**
 * 后台「直连」页的密钥。加密、主密钥和刷新节奏与 upstream-secrets 相同，
 * 不另起一套。写完立刻刷新本进程；其他 worker 在下一次 2 秒刷新里跟上。
 */

const AAD_PREFIX = 'gpt-direct:'

function aad(id: string): string {
  return `${AAD_PREFIX}${id}`
}

function operatorIdOf(value: string | null | undefined): string {
  return (value?.trim() || 'admin').slice(0, 200)
}

export function assertBudgetUsd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1_000_000) {
    throw new UpstreamSecretError('invalid_budget', 400, '月预算必须是正整数')
  }
  return value
}

function sealedRow(row: { nonce: string; tag: string; ciphertext: string }) {
  return { nonce: row.nonce, tag: row.tag, ciphertext: row.ciphertext }
}

async function hardDisabledFingerprints(): Promise<Set<string>> {
  const states = await db
    .select({
      fingerprint: schema.gpt_direct_key_state.fingerprint,
      disabled_reason: schema.gpt_direct_key_state.disabled_reason,
    })
    .from(schema.gpt_direct_key_state)
  return new Set(states.flatMap((row) => (row.disabled_reason ? [row.fingerprint] : [])))
}

/** 从库里重读。失败时留着上一份快照，避免一次查询失败把正在用的 key 丢掉。 */
export async function refreshGptDirectKeys(): Promise<void> {
  const master = readMasterKey()
  if (!master.ok) {
    resetAdminDirectKeySnapshot()
    return
  }
  try {
    const rows = await db
      .select()
      .from(schema.gpt_direct_admin_keys)
      .orderBy(asc(schema.gpt_direct_admin_keys.ordinal))
    const hardDisabled = await hardDisabledFingerprints()
    if (rows.length === 0) {
      noteDirectKeySnapshot({ admin: null, hardDisabled })
      return
    }
    const keys: DirectKey[] = []
    let ignored = 0
    for (const row of rows) {
      const secret = openSecret(aad(row.id), sealedRow(row))
      if (!secret) {
        ignored += 1
        continue
      }
      keys.push({
        id: row.id,
        ordinal: row.ordinal,
        secret,
        budgetUsd: row.budget_usd,
        enabled: row.enabled,
        ...fingerprintOf(secret),
      })
    }
    if (ignored > 0) {
      log.warn(
        { event: 'gpt.direct_admin_key_decrypt_failed', ignored },
        'some admin direct keys could not be decrypted',
      )
    }
    noteDirectKeySnapshot({ admin: keys, hardDisabled })
  } catch (err) {
    log.warn(
      {
        event: 'gpt.direct_admin_key_refresh_failed',
        err: err instanceof Error ? err.name : 'error',
      },
      'admin direct key refresh failed',
    )
  }
}

async function decryptedAdminKeys(): Promise<DirectKey[]> {
  await refreshGptDirectKeys()
  return adminDirectKeys() ?? []
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
    target_type: 'gpt_direct_key',
    target_id: targetId,
    details,
    created_at: createdAt,
  }
}

export async function createGptDirectKey(input: {
  apiKey: unknown
  budgetUsd: unknown
  operatorId: string | null
}): Promise<void> {
  const secret = assertSecretMaterial(input.apiKey)
  const budgetUsd = assertBudgetUsd(input.budgetUsd)
  const existing = await decryptedAdminKeys()
  const fingerprint = fingerprintOf(secret)
  if (existing.some((key) => key.fingerprint === fingerprint.fingerprint)) {
    throw new UpstreamSecretError('duplicate_key', 409, '这把密钥已经在列表里')
  }
  const id = randomUUID()
  const sealed = sealSecret(aad(id), secret)
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  const ordinal = existing.reduce((max, key) => Math.max(max, key.ordinal), 0) + 1
  await db.transaction(async (tx) => {
    await tx.insert(schema.gpt_direct_admin_keys).values({
      id,
      ordinal,
      budget_usd: budgetUsd,
      enabled: true,
      ...sealed,
      updated_at: now,
      updated_by: operatorId,
    })
    await tx.insert(schema.operator_audits).values(
      audit(
        operatorId,
        'gpt_direct_key.create',
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
  await refreshGptDirectKeys()
}

export async function updateGptDirectKey(input: {
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
    .from(schema.gpt_direct_admin_keys)
    .where(eq(schema.gpt_direct_admin_keys.id, input.id))
  if (!row) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
  const secret = openSecret(aad(row.id), sealedRow(row))
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    await tx
      .update(schema.gpt_direct_admin_keys)
      .set({
        ...(budgetUsd !== undefined ? { budget_usd: budgetUsd } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        updated_at: now,
        updated_by: operatorId,
      })
      .where(eq(schema.gpt_direct_admin_keys.id, row.id))
    await tx.insert(schema.operator_audits).values(
      audit(
        operatorId,
        'gpt_direct_key.update',
        row.id,
        {
          ...(secret ? { fingerprint: fingerprintOf(secret).label } : {}),
          ...(budgetUsd !== undefined ? { budget_usd: budgetUsd } : {}),
          ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        },
        now,
      ),
    )
  })
  await refreshGptDirectKeys()
}

export async function reorderGptDirectKeys(input: {
  ids: readonly string[]
  operatorId: string | null
}): Promise<void> {
  const rows = await db
    .select({ id: schema.gpt_direct_admin_keys.id })
    .from(schema.gpt_direct_admin_keys)
  const known = new Set(rows.map((row) => row.id))
  if (
    input.ids.length !== known.size ||
    input.ids.some((id) => !known.has(id)) ||
    new Set(input.ids).size !== input.ids.length
  ) {
    throw new UpstreamSecretError('invalid_order', 400, '顺序不完整')
  }
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    for (const [index, id] of input.ids.entries()) {
      await tx
        .update(schema.gpt_direct_admin_keys)
        .set({ ordinal: index + 1, updated_at: now, updated_by: operatorId })
        .where(eq(schema.gpt_direct_admin_keys.id, id))
    }
    await tx
      .insert(schema.operator_audits)
      .values(audit(operatorId, 'gpt_direct_key.reorder', 'order', { ids: [...input.ids] }, now))
  })
  await refreshGptDirectKeys()
}

export async function deleteGptDirectKey(input: {
  id: string
  operatorId: string | null
}): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.gpt_direct_admin_keys)
    .where(eq(schema.gpt_direct_admin_keys.id, input.id))
  if (!row) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
  const secret = openSecret(aad(row.id), sealedRow(row))
  const fingerprint = secret ? fingerprintOf(secret) : null
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    await tx.delete(schema.gpt_direct_admin_keys).where(eq(schema.gpt_direct_admin_keys.id, row.id))
    if (fingerprint) {
      await tx
        .delete(schema.gpt_direct_key_state)
        .where(eq(schema.gpt_direct_key_state.fingerprint, fingerprint.fingerprint))
    }
    await tx.insert(schema.operator_audits).values(
      audit(
        operatorId,
        'gpt_direct_key.delete',
        row.id,
        {
          ...(fingerprint ? { fingerprint: fingerprint.label } : {}),
        },
        now,
      ),
    )
  })
  await refreshGptDirectKeys()
}
