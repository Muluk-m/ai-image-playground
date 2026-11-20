import { CLIENT_ERROR_LIMITS, CLIENT_ERRORS_PATH } from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  parseClientErrorBatch,
  recordClientErrorRecoveries,
  recordClientErrors,
} from '../lib/client-errors'
import { clientAddress } from '../lib/http'
import { log } from '../lib/logger'
import { createWindowLimiter } from '../lib/rate-limit'
import { readLimitedBody } from '../lib/request-body'
import { resolveUserSession, USER_SESSION_COOKIE } from '../lib/user-session'

// 正常页面每分钟最多一两次上报（前端自己合批、限量）；出错循环的页面在这里被截住，不刷爆表。
const limiter = createWindowLimiter(60_000, 4096)
const PER_ADDRESS_PER_MINUTE = 30
const PER_DEVICE_PER_MINUTE = 10

/**
 * 浏览器错误上报。未登录也能报：启动失败时用户多半还没进到登录态。
 * beacon 用 `text/plain` 发 JSON 免掉预检，所以这里自己读原文再解析。
 * 先按来源地址限流，再读正文、查会话：被限流的请求不该再消耗内存和数据库连接。
 * 上报方不关心结果，丢弃与限流都只回状态码，不回原因。
 */
export const clientErrorRoutes = new Elysia().post(
  CLIENT_ERRORS_PATH,
  async ({ request, server, cookie, status }) => {
    const address = clientAddress(request, server?.requestIP(request)?.address ?? null)
    if (limiter.over(`ip:${address}`, PER_ADDRESS_PER_MINUTE)) {
      return status(429, { error: 'rate_limited' })
    }
    const raw = await readLimitedBody(request, CLIENT_ERROR_LIMITS.bodyBytes)
    if (raw === null) return status(413, { error: 'too_large' })
    const batch = parseClientErrorBatch(new TextDecoder().decode(raw))
    if (!batch) return status(400, { error: 'invalid_request' })
    if (batch.deviceId && limiter.over(`device:${batch.deviceId}`, PER_DEVICE_PER_MINUTE)) {
      return status(429, { error: 'rate_limited' })
    }
    if (batch.errors.length === 0 && batch.recoveries.length === 0) return status(204, null)

    try {
      const token = cookie[USER_SESSION_COOKIE]?.value
      const user = typeof token === 'string' && token ? await resolveUserSession(token) : null
      const meta = {
        deviceId: batch.deviceId,
        userId: user?.id ?? null,
        userAgent: request.headers.get('user-agent'),
      }
      await recordClientErrors(batch.errors, meta)
      await recordClientErrorRecoveries(batch.recoveries, meta)
    } catch (err) {
      log.error({ event: 'client_errors.record_failed', err }, 'failed to record client errors')
      return status(503, { error: 'unavailable' })
    }
    return status(204, null)
  },
  { parse: 'none' },
)
