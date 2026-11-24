/**
 * Config Worker（ADR 0035）：把 Secrets Store 里某个部署的密钥交给那个部署的主机。
 *
 * GET /v1/<prod|test|host>/secrets → { "secrets": { "S3_SECRET_ACCESS_KEY": "...", ... } }
 *
 * - 前面是 Cloudflare Access：每个部署一个 Access 应用，只放行该部署的 service token。
 *   这里再校验一遍 Access JWT 的签名、iss、aud 和有效期，路径里的部署必须和 aud 对得上，
 *   所以拿着 test 的 token 读不到 prod。workers.dev 入口关闭，只走自定义域名。
 * - 绑定名就是 Secrets Store 里的名字 `<部署>__<变量名>`，返回时去掉前缀。只读，没有写接口。
 * - 不记录任何值，响应禁止缓存。
 */

interface SecretBinding {
  get(): Promise<string>
}

interface Env {
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD_PROD: string
  ACCESS_AUD_TEST: string
  ACCESS_AUD_HOST: string
  [binding: string]: unknown
}

/** host 是宿主机级密钥（共享 PostgreSQL、GHCR），它的 Access 应用只放行 prod 的 token。 */
const DEPLOYMENTS = { prod: 'ACCESS_AUD_PROD', test: 'ACCESS_AUD_TEST', host: 'ACCESS_AUD_HOST' } as const
type Deployment = keyof typeof DEPLOYMENTS

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

const decodeJson = (value: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as Record<string, unknown>

interface Jwk extends JsonWebKey {
  kid?: string
}

let cachedKeys: { at: number; keys: Jwk[] } | undefined

async function accessKeys(teamDomain: string, refresh: boolean): Promise<Jwk[]> {
  if (!refresh && cachedKeys && Date.now() - cachedKeys.at < 10 * 60_000) return cachedKeys.keys
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error(`access certs HTTP ${response.status}`)
  const body = (await response.json()) as { keys?: Jwk[] }
  cachedKeys = { at: Date.now(), keys: body.keys ?? [] }
  return cachedKeys.keys
}

/** 校验 Access JWT；通过返回 true。任何解析错误都按不通过处理。 */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const [head, body, signature] = token.split('.')
    if (!head || !body || !signature) return false
    const header = decodeJson(head)
    const claims = decodeJson(body)
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false
    let jwk = (await accessKeys(teamDomain, false)).find((key) => key.kid === header.kid)
    // Access 约六周换一次密钥；没找到就刷新一次。
    jwk ??= (await accessKeys(teamDomain, true)).find((key) => key.kid === header.kid)
    if (!jwk) return false
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlBytes(signature),
      new TextEncoder().encode(`${head}.${body}`),
    )
    if (!valid) return false
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const seconds = now / 1000
    return (
      claims.iss === `https://${teamDomain}` &&
      audiences.includes(audience) &&
      typeof claims.exp === 'number' &&
      claims.exp > seconds &&
      (typeof claims.nbf !== 'number' || claims.nbf <= seconds + 60)
    )
  } catch {
    return false
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/v1\/(prod|test|host)\/secrets$/.exec(new URL(request.url).pathname)
    if (!match) return json(404, { error: 'not_found' })
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' })
    const deployment = match[1] as Deployment
    const audience = env[DEPLOYMENTS[deployment]]
    const token = request.headers.get('Cf-Access-Jwt-Assertion')
    if (
      typeof audience !== 'string' ||
      !audience ||
      !token ||
      !(await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, audience))
    ) {
      return json(403, { error: 'forbidden' })
    }
    const prefix = `${deployment.toUpperCase()}__`
    const secrets: Record<string, string> = {}
    for (const [binding, value] of Object.entries(env)) {
      if (!binding.startsWith(prefix)) continue
      const secret = value as Partial<SecretBinding>
      if (typeof secret?.get !== 'function') continue
      secrets[binding.slice(prefix.length)] = await secret.get()
    }
    return json(200, { secrets })
  },
}
