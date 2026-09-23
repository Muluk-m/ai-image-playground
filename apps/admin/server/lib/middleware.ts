import { Elysia } from 'elysia'
import { SESSION_COOKIE_NAME } from './constants'
import { verifySession } from './session'

/**
 * Elysia derive：从 cookie 校验 admin session。401 抛错 by setting status，路由
 * handler 通过 derive 出来的 `admin` 字段判断。挂在 protected routes 上。
 */
export const requireAuth = new Elysia({ name: 'requireAuth' }).derive(
  { as: 'scoped' },
  ({ cookie, set }) => {
    const cookieVal = cookie[SESSION_COOKIE_NAME]?.value
    const session = verifySession(typeof cookieVal === 'string' ? cookieVal : '')
    if (!session.valid || !session.operatorId) {
      set.status = 401
      throw new Error('unauthorized')
    }
    return { admin: { operatorId: session.operatorId } as const }
  },
)
