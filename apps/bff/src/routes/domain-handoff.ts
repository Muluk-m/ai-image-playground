import { randomBytes } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { domainHandoffConfig } from '../lib/domain-handoff-config'
import { clientAddress } from '../lib/http'
import { createRateLimiter } from '../lib/rate-limit'
import { resolveAuthUser } from '../lib/user-auth'
import {
  createUserSession,
  hashSessionToken,
  setUserSessionCookie,
  USER_SESSION_COOKIE,
} from '../lib/user-session'

const COMPLETE = '__Host-image_playground_domain_complete'
const starts = createRateLimiter({
  maxFailures: 30,
  windowMs: 120_000,
  lockMs: 120_000,
  maxEntries: 2048,
})
const COOKIE = 'image_playground_domain_handoff'
const TTL = 120_000
const OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth/domain',
  maxAge: TTL / 1000,
} as const
interface Handoff {
  expires: number
  binding: string
  returnPath: string
  issued: boolean
  code?: string
  userId?: string
  sessionHash?: string
}
// Short-lived authentication metadata only. A restart fails closed; browser data never enters this map.
const pending = new Map<string, Handoff>()
const random = () => randomBytes(32).toString('base64url')
function onHost(request: Request, origin: string): boolean {
  return new URL(request.url).host === new URL(origin).host
}
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}
function fallback(origin: string, path = '/'): Response {
  const source = new URL(path, origin)
  source.searchParams.delete('__domain_auth')
  source.searchParams.set('__legacy', '1')
  return redirect(source.href)
}
function returnUrl(origin: string, path: string): string {
  const url = new URL(path, origin)
  if (url.origin !== origin || url.pathname.startsWith('//')) throw new Error('Invalid return path')
  url.searchParams.set('__domain_auth', 'done')
  return url.href
}

export const domainHandoffRoutes = new Elysia()
  .use(resolveAuthUser)
  .get('/api/auth/domain/available', ({ request, cookie, set }) => {
    set.headers['cache-control'] = 'no-store'
    const config = domainHandoffConfig()
    return {
      enabled: !!config && onHost(request, config.targetApiOrigin),
      completed: cookie[COMPLETE]?.value === '1',
    }
  })
  .get(
    '/api/auth/domain/start',
    ({ request, query, cookie, authUser, status, server }) => {
      const config = domainHandoffConfig()
      if (!config || !onHost(request, config.targetApiOrigin)) return status(404)
      let path = query.return ?? '/'
      let destination: string
      try {
        destination = returnUrl(config.targetOrigin, path)
        const normalized = new URL(path, config.targetOrigin)
        path = normalized.pathname + normalized.search + normalized.hash
      } catch {
        return status(400)
      }
      if (authUser) {
        cookie[COMPLETE]!.set({ ...OPTIONS, path: '/', value: '1' })
        return redirect(destination)
      }
      const address = clientAddress(request, server?.requestIP(request)?.address ?? null)
      if (starts.isLocked(address) || starts.recordFailure(address))
        return fallback(config.sourceOrigin, path)
      const oldBinding = cookie[COOKIE]?.value
      for (const [key, flow] of pending) {
        if (typeof oldBinding === 'string' && flow.binding === hashSessionToken(oldBinding))
          pending.delete(key)
      }
      for (const [key, flow] of pending) if (flow.expires <= Date.now()) pending.delete(key)
      if (pending.size >= 2048) return fallback(config.sourceOrigin, path)
      const state = random(),
        binding = random()
      pending.set(state, {
        expires: Date.now() + TTL,
        binding: hashSessionToken(binding),
        returnPath: path,
        issued: false,
      })
      cookie[COOKIE]!.set({ ...OPTIONS, value: binding })
      return redirect(`${config.sourceApiOrigin}/api/auth/domain/authorize?state=${state}`)
    },
    { query: t.Object({ return: t.Optional(t.String({ maxLength: 4096 })) }) },
  )
  .get(
    '/api/auth/domain/authorize',
    ({ request, query, cookie, authUser, status }) => {
      const config = domainHandoffConfig()
      if (!config || !onHost(request, config.sourceApiOrigin)) return status(404)
      const flow = pending.get(query.state)
      if (!flow || flow.expires <= Date.now() || flow.issued)
        return fallback(config.sourceOrigin, flow?.returnPath)
      flow.issued = true
      const code = random()
      flow.code = hashSessionToken(code)
      if (authUser) {
        flow.userId = authUser.id
        flow.sessionHash = hashSessionToken(String(cookie[USER_SESSION_COOKIE]?.value ?? ''))
      }
      return redirect(
        `${config.targetApiOrigin}/api/auth/domain/finish?state=${query.state}&code=${code}`,
      )
    },
    { query: t.Object({ state: t.String({ minLength: 43, maxLength: 43 }) }) },
  )
  .get(
    '/api/auth/domain/finish',
    async ({ request, query, cookie, authUser, status }) => {
      const config = domainHandoffConfig()
      if (!config || !onHost(request, config.targetApiOrigin)) return status(404)
      const flow = pending.get(query.state)
      const binding = cookie[COOKIE]?.value
      if (
        !flow ||
        flow.expires <= Date.now() ||
        !flow.issued ||
        flow.code !== hashSessionToken(query.code) ||
        typeof binding !== 'string' ||
        hashSessionToken(binding) !== flow.binding
      )
        return fallback(config.sourceOrigin, flow?.returnPath)
      pending.delete(query.state)
      cookie[COOKIE]!.set({ ...OPTIONS, value: '', maxAge: 0 })
      // Never switch an already signed-in target account, even when the old domain has another account.
      if (!authUser && flow.userId && flow.sessionHash) {
        const token = await db
          .transaction(async (tx) => {
            const [user] = await tx
              .select()
              .from(schema.users)
              .where(eq(schema.users.id, flow.userId!))
              .for('update')
            if (!user || user.status !== 'active') return null
            const [source] = await tx
              .select()
              .from(schema.user_sessions)
              .where(
                and(
                  eq(schema.user_sessions.token_hash, flow.sessionHash!),
                  eq(schema.user_sessions.user_id, user.id),
                  gt(schema.user_sessions.expires_at, Date.now()),
                ),
              )
              .for('update')
            if (!source) return null
            const result = await createUserSession(user.id, tx)
            await tx
              .update(schema.user_sessions)
              .set({ expires_at: source.expires_at })
              .where(eq(schema.user_sessions.token_hash, hashSessionToken(result)))
            return result
          })
          .catch(() => null)
        if (!token) return fallback(config.sourceOrigin, flow.returnPath)
        setUserSessionCookie(cookie, token)
      }
      cookie[COMPLETE]!.set({ ...OPTIONS, path: '/', value: '1' })
      return redirect(returnUrl(config.targetOrigin, flow.returnPath))
    },
    {
      query: t.Object({
        state: t.String({ minLength: 43, maxLength: 43 }),
        code: t.String({ minLength: 43, maxLength: 43 }),
      }),
    },
  )
