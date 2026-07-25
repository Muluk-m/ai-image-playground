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
