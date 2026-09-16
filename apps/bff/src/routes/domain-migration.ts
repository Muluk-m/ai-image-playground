import { createHash, randomBytes } from 'node:crypto'
import { and, count, eq, gt, lt, sql, sum } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { domainMigrationConfig } from '../lib/domain-migration-config'
import { clientAddress } from '../lib/http'
import { createWindowLimiter } from '../lib/rate-limit'
import { resolveAuthUser } from '../lib/user-auth'
import {
  createUserSession,
  hashSessionToken,
  setUserSessionCookie,
  USER_SESSION_COOKIE,
} from '../lib/user-session'

const transfers = schema.domain_migrations
const chunks = schema.domain_migration_chunks
const ttl = 60 * 60_000
const limiter = createWindowLimiter(ttl)
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const secret = () => randomBytes(32).toString('hex')
const token = t.String({ pattern: '^[a-f0-9]{64}$' })
const proofBody = { id: token, proof: token }
const uploadBody = { id: token, uploadKey: token }

function allowed(request: Request, side: 'source' | 'target'): boolean {
  const c = domainMigrationConfig()
  if (!c) return false
  return (
    request.headers.get('origin') === c[`${side}Origin`] &&
    new URL(request.url).host === new URL(c[`${side}Api`]).host
  )
}

export const domainMigrationRoutes = new Elysia()
  .use(resolveAuthUser)
  .get('/api/domain-migration/config', ({ set }) => {
    set.headers['cache-control'] = 'no-store'
    return domainMigrationConfig()
  })
  .post(
    '/api/domain-migration/start',
    async ({ body, request, server, cookie, authUser, status, set }) => {
      set.headers['cache-control'] = 'no-store'
      if (!allowed(request, 'source')) return status(403, { error: 'migration_origin' })
      if (limiter.over(clientAddress(request, server?.requestIP(request)?.address ?? null), 10)) {
        return status(429, { error: 'migration_rate_limited' })
      }
      const id = secret(),
        uploadKey = secret()
      const raw = cookie[USER_SESSION_COOKIE]?.value
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('domain-migration-capacity'))`)
        await tx.delete(transfers).where(lt(transfers.expires_at, Date.now()))
        const [active] = await tx.select({ count: count() }).from(transfers)
        if ((active?.count ?? 0) >= 32) return null
        await tx.insert(transfers).values({
          id,
          proof_hash: body.challenge,
          upload_hash: digest(uploadKey),
          source_user_id: authUser?.id ?? null,
          source_session_hash: authUser && typeof raw === 'string' ? hashSessionToken(raw) : null,
          created_at: Date.now(),
          expires_at: Date.now() + ttl,
        })
        return { id, uploadKey }
      })
      return row ?? status(429, { error: 'migration_busy' })
    },
    { body: t.Object({ challenge: token }) },
  )
  .post(
    '/api/domain-migration/upload',
    async ({ body, request, status }) => {
      if (!allowed(request, 'source')) return status(403, { error: 'migration_origin' })
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('domain-migration-capacity'))`)
        const [row] = await tx
          .select()
          .from(transfers)
          .where(and(eq(transfers.id, body.id), gt(transfers.expires_at, Date.now())))
          .for('update')
        if (!row || row.upload_hash !== digest(body.uploadKey) || row.sealed)
          return status(403, { error: 'migration_invalid' })
        const [existing] = await tx
          .select()
          .from(chunks)
          .where(and(eq(chunks.migration_id, body.id), eq(chunks.sequence, body.sequence)))
        if (existing)
          return existing.ciphertext === body.ciphertext
            ? { ok: true }
            : status(409, { error: 'migration_sequence' })
        if (body.sequence !== row.chunks) return status(409, { error: 'migration_sequence' })
        const [total] = await tx.select({ bytes: sum(transfers.bytes) }).from(transfers)
        if (
          row.bytes + body.ciphertext.length > 512 * 1024 * 1024 ||
          Number(total?.bytes ?? 0) + body.ciphertext.length > 1024 * 1024 * 1024
        ) {
          return status(413, { error: 'migration_capacity' })
        }
        await tx
          .insert(chunks)
          .values({ migration_id: body.id, sequence: body.sequence, ciphertext: body.ciphertext })
        await tx
          .update(transfers)
          .set({ chunks: row.chunks + 1, bytes: row.bytes + body.ciphertext.length })
          .where(eq(transfers.id, body.id))
        return { ok: true }
      })
    },
    {
      body: t.Object({
        ...uploadBody,
        sequence: t.Integer({ minimum: 0, maximum: 10000 }),
        ciphertext: t.String({ maxLength: 1_500_000, minLength: 1 }),
      }),
    },
  )
  .post(
    '/api/domain-migration/seal',
    async ({ body, request, status }) => {
      if (!allowed(request, 'source')) return status(403, { error: 'migration_origin' })
      const rows = await db
        .update(transfers)
        .set({ sealed: 1 })
        .where(
          and(
            eq(transfers.id, body.id),
            eq(transfers.upload_hash, digest(body.uploadKey)),
            eq(transfers.chunks, body.chunks),
            gt(transfers.expires_at, Date.now()),
          ),
        )
        .returning({ id: transfers.id })
      return rows.length ? { ok: true } : status(409, { error: 'migration_incomplete' })
    },
    { body: t.Object({ ...uploadBody, chunks: t.Integer({ minimum: 0 }) }) },
  )
  .post(
    '/api/domain-migration/read',
    async ({ body, request, authUser, status, set }) => {
      set.headers['cache-control'] = 'no-store'
      if (!allowed(request, 'target')) return status(403, { error: 'migration_origin' })
      const [row] = await db
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.id, body.id),
            eq(transfers.proof_hash, digest(body.proof)),
            eq(transfers.sealed, 1),
            gt(transfers.expires_at, Date.now()),
          ),
        )
      if (!row) return status(410, { error: 'migration_expired' })
      if (authUser && row.source_user_id && authUser.id !== row.source_user_id)
        return status(409, { error: 'migration_account_conflict' })
      const [chunk] = await db
        .select()
        .from(chunks)
        .where(and(eq(chunks.migration_id, body.id), eq(chunks.sequence, body.sequence)))
      return { chunks: row.chunks, ciphertext: chunk?.ciphertext ?? null }
    },
    { body: t.Object({ ...proofBody, sequence: t.Integer({ minimum: 0 }) }) },
  )
  .post(
    '/api/domain-migration/finish',
    async ({ body, request, cookie, authUser, status, set }) => {
      set.headers['cache-control'] = 'no-store'
      if (!allowed(request, 'target')) return status(403, { error: 'migration_origin' })
      const result = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(transfers)
          .where(
            and(
              eq(transfers.id, body.id),
              eq(transfers.proof_hash, digest(body.proof)),
              eq(transfers.sealed, 1),
              gt(transfers.expires_at, Date.now()),
            ),
          )
          .for('update')
        if (!row) return { error: 'migration_expired' } as const
        if (authUser && row.source_user_id && authUser.id !== row.source_user_id)
          return { error: 'migration_account_conflict' } as const
        let session: string | null = null
        if (row.source_session_hash && !authUser) {
          const [source] = await tx
            .select({ id: schema.users.id, expires: schema.user_sessions.expires_at })
            .from(schema.user_sessions)
            .innerJoin(schema.users, eq(schema.users.id, schema.user_sessions.user_id))
            .where(
              and(
                eq(schema.user_sessions.token_hash, row.source_session_hash),
                gt(schema.user_sessions.expires_at, Date.now()),
                eq(schema.users.status, 'active'),
              ),
            )
          if (!source) return { error: 'migration_session_expired' } as const
          session = await createUserSession(source.id, tx)
          await tx
            .update(schema.user_sessions)
            .set({ expires_at: source.expires })
            .where(eq(schema.user_sessions.token_hash, hashSessionToken(session)))
        }
        await tx.delete(transfers).where(eq(transfers.id, body.id))
        return { session }
      })
      if ('error' in result) return status(409, { error: result.error })
      if (result.session) setUserSessionCookie(cookie, result.session)
      return { ok: true }
    },
    { body: t.Object(proofBody) },
  )
