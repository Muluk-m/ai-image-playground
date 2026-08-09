import { timingSafeEqual } from 'node:crypto'
import type { AuthUserView } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { config } from '../config'
import { resolveUserSession, USER_SESSION_COOKIE } from './user-session'

/**
 * 认证关闭时返回 null 但不拦截；认证开启时解析当前有效账号。
 */
export const resolveAuthUser = new Elysia({ name: 'resolve-auth-user' }).derive(
  { as: 'scoped' },
  async ({ cookie }) => {
    if (!config.auth.enabled) return { authUser: null as AuthUserView | null }
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const token = typeof raw === 'string' ? raw : ''
    return { authUser: await resolveUserSession(token) }
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
  .derive({ as: 'scoped' }, async ({ cookie, request }) => {
    if (!config.auth.enabled) {
      return {
        authUser: null as AuthUserView | null,
        serviceIdentity: false,
      }
    }
    if (hasInternalServiceIdentity(request)) {
      return {
        authUser: null as AuthUserView | null,
        serviceIdentity: true,
      }
    }
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const token = typeof raw === 'string' ? raw : ''
    return {
      authUser: await resolveUserSession(token),
      serviceIdentity: false,
    }
  })
  .onBeforeHandle({ as: 'scoped' }, ({ authUser, serviceIdentity, status }) => {
    if (config.auth.enabled && !authUser && !serviceIdentity) {
      return status(401, { error: 'unauthorized' })
    }
  })

/**
 * 业务路由统一挂这个 plugin。AUTH_ENABLED=false 时保持匿名兼容；开启后无有效
 * session 一律在 handler 前返回 401。
 */
export const requireUser = new Elysia({ name: 'require-user' })
  .derive({ as: 'scoped' }, async ({ cookie }) => {
    if (!config.auth.enabled) return { authUser: null as AuthUserView | null }
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const token = typeof raw === 'string' ? raw : ''
    return { authUser: await resolveUserSession(token) }
  })
  .onBeforeHandle({ as: 'scoped' }, ({ authUser, status }) => {
    if (config.auth.enabled && !authUser) {
      return status(401, { error: 'unauthorized' })
    }
  })
