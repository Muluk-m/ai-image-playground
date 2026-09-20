import { randomBytes } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { isCapabilityEnabled } from '../lib/capabilities'
import { type DomainHandoffConfig, domainHandoffConfig } from '../lib/domain-handoff-config'
import { clientAddress } from '../lib/http'
import { createWindowLimiter } from '../lib/rate-limit'
import { resolveAuthUser } from '../lib/user-auth'
import {
  createUserSession,
  hashSessionToken,
  setUserSessionCookie,
  USER_SESSION_COOKIE,
} from '../lib/user-session'

const COMPLETE = '__Host-image_playground_domain_complete'
const COOLDOWN = '__Host-image_playground_domain_cooldown'
// 吞吐限速，不是失败锁定：成功的交接不能记成 failure（见 lib/rate-limit.ts）。
const starts = createWindowLimiter(120_000, 2048)
const START_BUDGET = 30
// `__Host-` 前缀：同注册域下的兄弟主机不能用 Domain= 覆盖它。整个设计只靠这一个
// cookie 把兑换绑到发起它的浏览器上，被覆盖等于强制登录。前缀要求 Path=/ 且无 Domain。
const COOKIE = '__Host-image_playground_domain_handoff'
const TTL = 120_000
const OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
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
// 交接任何一步失败都留在**新**域名上，只在 cookie 里按两分钟停一次交接尝试。旧域名只有一条
// 一次性 301 指向这里，把访客送回去会立刻被弹回来，来回切一次也不该发生；停两分钟是为了
// 不和前端的「available.enabled 就发起 start」形成回环，两分钟后照常再试。
function giveUp(
  jar: Record<string, { set(options: Record<string, unknown> & { value: string }): void }>,
  config: DomainHandoffConfig,
  path = '/',
): Response {
  jar[COOLDOWN]?.set({ ...OPTIONS, value: '1' })
  const target = new URL(path, config.targetOrigin)
  target.searchParams.delete('__domain_auth')
  return redirect(target.href)
}
function returnUrl(origin: string, path: string): string {
  const url = new URL(path, origin)
  if (url.origin !== origin || url.pathname.startsWith('//')) throw new Error('Invalid return path')
  url.searchParams.set('__domain_auth', 'done')
  return url.href
}

// 与其它 /api/auth/* 一样受 accounts:login 管：能力关掉时交接也签不出会话。
function handoffConfig() {
  return isCapabilityEnabled('accounts:login') ? domainHandoffConfig() : null
}

export const domainHandoffRoutes = new Elysia()
  .use(resolveAuthUser)
  .get('/api/auth/domain/available', ({ request, cookie, set }) => {
    set.headers['cache-control'] = 'no-store'
    const config = handoffConfig()
    return {
      enabled:
        !!config && onHost(request, config.targetApiOrigin) && cookie[COOLDOWN]?.value !== '1',
      completed: cookie[COMPLETE]?.value === '1',
    }
  })
  .get(
    '/api/auth/domain/start',
    ({ request, query, cookie, authUser, status, server }) => {
      const config = handoffConfig()
      if (!config || !onHost(request, config.targetApiOrigin)) return status(404)
      // `//p/x` 这种协议相对路径会解析到别的 origin；当根路径处理，不要把正常访客顶成 400。
      let path = query.return?.startsWith('//') ? '/' : (query.return ?? '/')
      let destination: string
      try {
        destination = returnUrl(config.targetOrigin, path)
        const normalized = new URL(path, config.targetOrigin)
        path = normalized.pathname + normalized.search + normalized.hash
      } catch {
        return status(400)
      }
      if (authUser) {
        cookie[COMPLETE]!.set({ ...OPTIONS, value: '1' })
        return redirect(destination)
      }
      const address = clientAddress(request, server?.requestIP(request)?.address ?? null)
      if (starts.over(address, START_BUDGET)) return giveUp(cookie, config, path)
      const oldBinding = cookie[COOKIE]?.value
      for (const [key, flow] of pending) {
        if (typeof oldBinding === 'string' && flow.binding === hashSessionToken(oldBinding))
          pending.delete(key)
      }
      for (const [key, flow] of pending) if (flow.expires <= Date.now()) pending.delete(key)
      if (pending.size >= 2048) return giveUp(cookie, config, path)
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
      const config = handoffConfig()
      if (!config || !onHost(request, config.sourceApiOrigin)) return status(404)
      const flow = pending.get(query.state)
      if (!flow || flow.expires <= Date.now() || flow.issued)
        return giveUp(cookie, config, flow?.returnPath)
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
      const config = handoffConfig()
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
        return giveUp(cookie, config, flow?.returnPath)
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
        if (!token) return giveUp(cookie, config, flow.returnPath)
        setUserSessionCookie(cookie, token)
      }
      cookie[COMPLETE]!.set({ ...OPTIONS, value: '1' })
      return redirect(returnUrl(config.targetOrigin, flow.returnPath))
    },
    {
      query: t.Object({
        state: t.String({ minLength: 43, maxLength: 43 }),
        code: t.String({ minLength: 43, maxLength: 43 }),
      }),
    },
  )
