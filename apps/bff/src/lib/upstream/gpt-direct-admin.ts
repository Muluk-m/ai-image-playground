import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import {
  assertSecretMaterial,
  openSecret,
  readMasterKey,
  refreshUpstreamSecrets,
  sealSecret,
  UpstreamSecretError,
} from '../upstream-secrets'
import { fingerprintMacSource } from './gpt-direct-availability'
import {
  type DirectKey,
  FingerprintSecretMissingError,
  fingerprintOf,
  noteDirectKeySnapshot,
} from './gpt-key-config'
import { selectDirectKey } from './gpt-keys'

/**
 * 后台「直连」页的密钥。加密、主密钥和刷新节奏与 upstream-secrets 相同，
 * 不另起一套。写完立刻刷新本进程；其他 worker 在下一次 10 秒刷新里跟上。
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

let refreshRequested = 0
let refreshChain: Promise<void> = Promise.resolve()
let cachedRevision: string | undefined
let cachedMasterKey: Buffer | undefined
let cachedFingerprintSecret: string | undefined
let cachedKeys: DirectKey[] | undefined

/** 串行刷新。读到一半又有更新时，旧结果不写回快照。 */
export function refreshGptDirectKeys(): Promise<void> {
  const ticket = ++refreshRequested
  const run = refreshChain.then(
    () => refreshGptDirectKeysOnce(ticket),
    () => refreshGptDirectKeysOnce(ticket),
  )
  refreshChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 先刷新上游密钥，再刷新直连密钥清单：直连的环境变量那一把可能被「上游密钥」页替换，
 * 要等替换生效后才能算指纹、探可用性。两步各自失败互不影响，任一失败最后抛出第一个错误，
 * 由调用方记日志。
 */
export async function refreshUpstreamKeySources(): Promise<void> {
  const failures: unknown[] = []
  try {
    await refreshUpstreamSecrets()
  } catch (error) {
    failures.push(error)
  }
  try {
    await refreshGptDirectKeys()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) throw failures[0]
}

async function publishSnapshot(admin: DirectKey[] | null): Promise<void> {
  const states = await db.select().from(schema.gpt_direct_key_state)
  const hardDisabled = new Set(
    states.filter((row) => row.disabled_reason !== null).map((row) => row.fingerprint),
  )
  noteDirectKeySnapshot({ admin, hardDisabled, deliverable: false })
  const probe = await selectDirectKey({
    estimateMicroUsd: 1,
    state: new Map(states.map((row) => [row.fingerprint, row])),
  })
  if (probe) noteDirectKeySnapshot({ admin, hardDisabled, deliverable: true })
}

/** 从库里重读。失败时留着上一份快照，避免一次查询失败把正在用的 key 丢掉。 */
async function refreshGptDirectKeysOnce(ticket: number): Promise<void> {
  if (ticket !== refreshRequested) return
  const fingerprintSource = fingerprintMacSource()
  const fingerprintSecret = fingerprintSource === 'unset' ? '' : process.env[fingerprintSource]
  if (fingerprintMacSource() === 'unset') {
    cachedRevision = undefined
    log.error(
      { event: 'gpt.fingerprint_secret_missing' },
      'direct fingerprint secret is unset; admin keys and direct routing stay unavailable',
    )
    try {
      const [row] = await db
        .select({ id: schema.gpt_direct_admin_keys.id })
        .from(schema.gpt_direct_admin_keys)
        .limit(1)
      if (ticket !== refreshRequested) return
      noteDirectKeySnapshot({ admin: row ? [] : null, deliverable: false })
    } catch (err) {
      log.warn(
        {
          event: 'gpt.direct_admin_key_refresh_failed',
          err: err instanceof Error ? err.name : 'error',
        },
        'admin direct key refresh failed',
      )
    }
    return
  }
  const master = readMasterKey()
  if (!master.ok) {
    cachedRevision = undefined
    try {
      const [row] = await db
        .select({ id: schema.gpt_direct_admin_keys.id })
        .from(schema.gpt_direct_admin_keys)
        .limit(1)
      if (ticket !== refreshRequested) return
      if (row) {
        log.warn(
          { event: 'gpt.direct_admin_key_unavailable', reason: master.code },
          'admin direct keys exist but the master key cannot open them',
        )
        noteDirectKeySnapshot({ admin: [], deliverable: false })
        return
      }
      noteDirectKeySnapshot({ admin: null, deliverable: false })
      await selectDirectKey({ estimateMicroUsd: 1 })
    } catch (err) {
      log.warn(
        {
          event: 'gpt.direct_admin_key_refresh_failed',
          err: err instanceof Error ? err.name : 'error',
        },
        'admin direct key refresh failed',
      )
    }
    return
  }
  try {
    const [version] = await db.execute<{ revision: string }>(sql`
      SELECT md5(COALESCE(jsonb_agg(to_jsonb(keys) ORDER BY keys.id)::text, '[]')) AS revision
      FROM ${schema.gpt_direct_admin_keys} AS keys
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
      .from(schema.gpt_direct_admin_keys)
      .orderBy(asc(schema.gpt_direct_admin_keys.ordinal))
    if (ticket !== refreshRequested) return
    if (rows.length === 0) {
      noteDirectKeySnapshot({ admin: null, deliverable: false })
      await selectDirectKey({ estimateMicroUsd: 1 })
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
      const fingerprint = fingerprintOf(secret)
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
        { event: 'gpt.direct_admin_key_decrypt_failed', ignored },
        'some admin direct keys could not be decrypted',
      )
    }
    if (ticket !== refreshRequested) return
    if (keys.length === 0) {
      noteDirectKeySnapshot({ admin: [], deliverable: false })
      return
    }
    await publishSnapshot(keys)
    cachedRevision = version?.revision
    cachedMasterKey = master.key
    cachedFingerprintSecret = fingerprintSecret
    cachedKeys = keys
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

function uniqueViolation(error: unknown): boolean {
  const errno = (error as { cause?: { errno?: unknown } } | null)?.cause?.errno
  return String(errno ?? '') === '23505' || String(error).includes('23505')
}

export async function createGptDirectKey(input: {
  apiKey: unknown
  budgetUsd: unknown
  operatorId: string | null
}): Promise<void> {
  const secret = assertSecretMaterial(input.apiKey)
  const budgetUsd = assertBudgetUsd(input.budgetUsd)
  let fingerprint: ReturnType<typeof fingerprintOf>
  try {
    fingerprint = fingerprintOf(secret)
  } catch (error) {
    if (error instanceof FingerprintSecretMissingError) {
      throw new UpstreamSecretError('fingerprint_secret_missing', 503, error.message)
    }
    throw error
  }
  const id = randomUUID()
  const sealed = sealSecret(aad(id), secret)
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gpt-direct-admin-keys'))`)
      const [maxRow] = await tx
        .select({
          value: sql<number>`coalesce(max(${schema.gpt_direct_admin_keys.ordinal}), 0)`,
        })
        .from(schema.gpt_direct_admin_keys)
      const ordinal = Number(maxRow?.value ?? 0) + 1
      await tx.insert(schema.gpt_direct_admin_keys).values({
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
  } catch (error) {
    if (uniqueViolation(error)) {
      throw new UpstreamSecretError('duplicate_key', 409, '这把密钥已经在列表里')
    }
    throw error
  }
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
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    // 和新增、排序、删除同一把锁：并发删除时这里不能悄悄改到 0 行还写一条审计。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gpt-direct-admin-keys'))`)
    const updated = await tx
      .update(schema.gpt_direct_admin_keys)
      .set({
        ...(budgetUsd !== undefined ? { budget_usd: budgetUsd } : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        updated_at: now,
        updated_by: operatorId,
      })
      .where(eq(schema.gpt_direct_admin_keys.id, row.id))
      .returning({ id: schema.gpt_direct_admin_keys.id })
    if (updated.length === 0) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
    await tx.insert(schema.operator_audits).values(
      audit(
        operatorId,
        'gpt_direct_key.update',
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
  await refreshGptDirectKeys()
}

export async function reorderGptDirectKeys(input: {
  ids: readonly string[]
  revision: number
  operatorId: string | null
}): Promise<void> {
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gpt-direct-admin-keys'))`)
    const rows = await tx
      .select({
        id: schema.gpt_direct_admin_keys.id,
        updated_at: schema.gpt_direct_admin_keys.updated_at,
      })
      .from(schema.gpt_direct_admin_keys)
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
  // 解不开密文（主密钥换了）也要能删，并且清掉这把的停用与冷却状态：按库里存的指纹清，不靠解密。
  const now = Date.now()
  const operatorId = operatorIdOf(input.operatorId)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gpt-direct-admin-keys'))`)
    const removed = await tx
      .delete(schema.gpt_direct_admin_keys)
      .where(eq(schema.gpt_direct_admin_keys.id, row.id))
      .returning({ id: schema.gpt_direct_admin_keys.id })
    if (removed.length === 0) throw new UpstreamSecretError('unknown_key', 404, '没有这把密钥')
    await tx
      .delete(schema.gpt_direct_key_state)
      .where(eq(schema.gpt_direct_key_state.fingerprint, row.fingerprint))
    await tx
      .insert(schema.operator_audits)
      .values(
        audit(operatorId, 'gpt_direct_key.delete', row.id, { fingerprint: row.fingerprint }, now),
      )
  })
  await refreshGptDirectKeys()
}
