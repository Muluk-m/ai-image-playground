import { createRateLimiter } from './rate-limit'

/** One limiter for every way into a session, so a locked address cannot switch methods. */
export const loginLimiter = createRateLimiter({
  maxFailures: 5,
  windowMs: 60_000,
  lockMs: 10 * 60_000,
  maxEntries: 1024,
})

export function clientKey(request: Request): string {
  // Cloudflare tunnel 把客户端 IP 放 CF-Connecting-IP；标准 X-Forwarded-For
  // 取首段；都没就用 'unknown'（测试 / 本机 dev）
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return 'unknown'
}
