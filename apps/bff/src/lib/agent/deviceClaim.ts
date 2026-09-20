import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'

/**
 * 持有性证明，只服务于「领养」一个动作。
 *
 * 设备标识由客户端自述是既有模型（见 CONTEXT.md「设备」），本模块不改它：读会话、续播、
 * 匿名配额照旧只看自述的标识。它只回答领养要问的那个问题——**这个浏览器是不是真的持有
 * 这个设备标识**，而不只是在某处看到过它。
 *
 * 做法是首次见到某个设备标识时登记一行随机令牌，同时下发 HttpOnly cookie。登记之后不再改绑：
 * 从访问日志、代理日志或分享链接里捡到一个设备标识的人，换个浏览器拿不到那张 cookie。
 */
export const DEVICE_CLAIM_COOKIE = 'image_playground_device'

const CLAIM_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** 与会话 cookie 同一套作用域：跨子域同站发出，JavaScript 读不到。 */
const CLAIM_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: CLAIM_TTL_MS / 1000,
} as const

interface MutableCookie {
  value?: string
  set(options: Record<string, unknown> & { value: string }): void
}

export type CookieJar = Record<string, MutableCookie | undefined>

function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 登记设备标识并下发 cookie。已登记的设备**不改绑**——这正是防线本身：第二个浏览器
 * 报同一个标识时，这里什么都不做，它永远拿不到能领养的那张 cookie。
 */
export async function ensureDeviceClaim(deviceId: string, cookie: CookieJar): Promise<void> {
  const jar = cookie[DEVICE_CLAIM_COOKIE]
  if (!jar) return
  const existing = await db
    .select({ token_hash: schema.agent_device_claims.token_hash })
    .from(schema.agent_device_claims)
    .where(eq(schema.agent_device_claims.device_id, deviceId))
    .limit(1)
  if (existing.length > 0) {
    // 已登记：只有拿着对的 cookie 才续期，否则连「这个设备已登记」都不透露。
    if (jar.value && hashClaimToken(jar.value) === existing[0]!.token_hash) {
      jar.set({ ...CLAIM_COOKIE_OPTIONS, value: jar.value })
    }
    return
  }
  const token = randomBytes(32).toString('base64url')
  // 并发的首次请求会撞主键：谁先落谁算数，后来的那个不覆盖，也就不发 cookie。
  const inserted = await db
    .insert(schema.agent_device_claims)
    .values({ device_id: deviceId, token_hash: hashClaimToken(token), created_at: Date.now() })
    .onConflictDoNothing()
    .returning({ device_id: schema.agent_device_claims.device_id })
  if (inserted.length === 0) return
  jar.set({ ...CLAIM_COOKIE_OPTIONS, value: token })
}

/** 这个浏览器是否持有该设备标识。没有登记行时为假——无证明即不得领养。 */
export async function holdsDeviceClaim(deviceId: string, cookie: CookieJar): Promise<boolean> {
  const token = cookie[DEVICE_CLAIM_COOKIE]?.value
  if (!token) return false
  const rows = await db
    .select({ token_hash: schema.agent_device_claims.token_hash })
    .from(schema.agent_device_claims)
    .where(eq(schema.agent_device_claims.device_id, deviceId))
    .limit(1)
  return rows.length > 0 && hashClaimToken(token) === rows[0]!.token_hash
}
