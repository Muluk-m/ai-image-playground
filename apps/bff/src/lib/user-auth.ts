import { timingSafeEqual } from 'node:crypto'
import type { AuthUserView } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { config } from '../config'
import { isCapabilityEnabled } from './capabilities'
import {
  resolveUserSession,
  sessionClientFromRequest,
  USER_LOGOUT_PATH,
  USER_SESSION_COOKIE,
} from './user-session'

/**
 * 本次请求解析出的登录用户 id，只给访问日志用：全局的 onAfterResponse 拿不到各路由插件
 * derive 出来的 authUser。按 Request 弱引用，请求结束随之回收。
 */
const requestUsers = new WeakMap<Request, string>()
function rememberUser(request: Request, user: AuthUserView | null): AuthUserView | null {
  if (user) requestUsers.set(request, user.id)
  return user
}
export function requestAuthUserId(request: Request): string | undefined {
  return requestUsers.get(request)
}

/** Resolve a valid cookie independently from whether new logins are enabled. */
export const resolveAuthUser = new Elysia({ name: 'resolve-auth-user' }).derive(
  { as: 'scoped' },
  async ({ cookie, request, server }) => {
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const token = typeof raw === 'string' ? raw : ''
    const client = sessionClientFromRequest(request, server?.requestIP(request)?.address ?? null)
    // 登出要先按会话主人收回阶段授权。derive 不能先删掉禁用账号的会话。
    const keepDisabledSession = new URL(request.url).pathname === USER_LOGOUT_PATH
    return {
      authUser: rememberUser(
        request,
        await resolveUserSession(token, client, { keepDisabledSession }),
      ),
    }
  },
)

function hasInternalServiceIdentity(request: Request): boolean {
  const configured = config.auth.internalApiToken
  const authorization = request.headers.get('authorization')
  if (!configured || !authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length))
  const expected = Buffer.from(configured)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
/** Internal operational routes always require the configured service credential. */
export const requireInternalService = new Elysia({
  name: 'require-internal-service',
}).onBeforeHandle({ as: 'scoped' }, ({ request, status }) => {
  if (!hasInternalServiceIdentity(request)) return status(401, { error: 'unauthorized' })
})

/**
 * Result and image reads also accept the Admin service credential. Other user routes keep using
 * requireUser, so service identity cannot submit, cancel, or otherwise act as a user.
 */
export const requireUserOrService = new Elysia({ name: 'require-user-or-service' })
  .derive({ as: 'scoped' }, async ({ cookie, request, server }) => {
    if (hasInternalServiceIdentity(request)) {
      return {
        authUser: null as AuthUserView | null,
        serviceIdentity: true,
      }
    }
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const token = typeof raw === 'string' ? raw : ''
    const client = sessionClientFromRequest(request, server?.requestIP(request)?.address ?? null)
    return {
      authUser: rememberUser(request, await resolveUserSession(token, client)),
      serviceIdentity: false,
    }
  })
  .onBeforeHandle({ as: 'scoped' }, ({ authUser, serviceIdentity, status }) => {
    if (isCapabilityEnabled('accounts:login') && !authUser && !serviceIdentity) {
      return status(401, { error: 'unauthorized' })
    }
  })

/** Account login is the only deployment capability; ownership remains a row-level fact. */
export const requireUser = new Elysia({ name: 'require-user' })
  .derive({ as: 'scoped' }, async ({ cookie, request, server }) => {
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const token = typeof raw === 'string' ? raw : ''
    const client = sessionClientFromRequest(request, server?.requestIP(request)?.address ?? null)
    return { authUser: rememberUser(request, await resolveUserSession(token, client)) }
  })
  .onBeforeHandle({ as: 'scoped' }, ({ authUser, status }) => {
    if (isCapabilityEnabled('accounts:login') && !authUser) {
      return status(401, { error: 'unauthorized' })
    }
  })
