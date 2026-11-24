import { afterEach, describe, expect, it } from 'bun:test'
import worker, { verifyAccessJwt } from '../../../../deploy/config-worker/src/index'
import { bootstrapFor } from '../deploy-config-cli'

const TEAM = 'team.cloudflareaccess.com'
const realFetch = globalThis.fetch

const encode = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

async function issuer() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const kid = crypto.randomUUID()
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid }
  globalThis.fetch = (async (url: string) =>
    String(url) === `https://${TEAM}/cdn-cgi/access/certs`
      ? Response.json({ keys: [jwk] })
      : new Response('no', { status: 404 })) as unknown as typeof fetch
  return async (claims: Record<string, unknown>) => {
    const head = encode({ alg: 'RS256', kid })
    const body = encode(claims)
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    )
    return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`
  }
}

const later = () => Math.floor(Date.now() / 1000) + 300

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('config worker', () => {
  it('accepts only a signed, unexpired Access token for the right application', async () => {
    const sign = await issuer()
    const good = await sign({ iss: `https://${TEAM}`, aud: ['aud-prod'], exp: later() })
    expect(await verifyAccessJwt(good, TEAM, 'aud-prod')).toBe(true)
    expect(await verifyAccessJwt(good, TEAM, 'aud-test')).toBe(false)
    const expired = await sign({ iss: `https://${TEAM}`, aud: 'aud-prod', exp: 1 })
    expect(await verifyAccessJwt(expired, TEAM, 'aud-prod')).toBe(false)
    const foreign = await sign({
      iss: 'https://other.cloudflareaccess.com',
      aud: 'aud-prod',
      exp: later(),
    })
    expect(await verifyAccessJwt(foreign, TEAM, 'aud-prod')).toBe(false)
    const [head, body] = good.split('.')
    const tampered = `${head}.${encode({ iss: `https://${TEAM}`, aud: 'aud-prod', exp: later() + 9 })}.${good.split('.')[2]}`
    expect(body).toBeTruthy()
    expect(await verifyAccessJwt(tampered, TEAM, 'aud-prod')).toBe(false)
    expect(await verifyAccessJwt('not-a-jwt', TEAM, 'aud-prod')).toBe(false)
  })

  it('serves a deployment only its own secrets, with the prefix stripped and no caching', async () => {
    const sign = await issuer()
    const env = {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD_PROD: 'aud-prod',
      ACCESS_AUD_TEST: 'aud-test',
      ACCESS_AUD_HOST: 'aud-host',
      PROD__S3_SECRET_ACCESS_KEY: { get: async () => 'prod-s3' },
      TEST__S3_SECRET_ACCESS_KEY: { get: async () => 'test-s3' },
      HOST__POSTGRES_PASSWORD: { get: async () => 'host-pg' },
    }
    const call = async (path: string, aud: string) => {
      const token = await sign({ iss: `https://${TEAM}`, aud, exp: later() })
      return worker.fetch(
        new Request(`https://config.example${path}`, {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        env,
      )
    }
    const ok = await call('/v1/test/secrets', 'aud-test')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(await ok.json()).toEqual({ secrets: { S3_SECRET_ACCESS_KEY: 'test-s3' } })
    // test 的 Access 应用签出来的 token 读不了 prod。
    expect((await call('/v1/prod/secrets', 'aud-test')).status).toBe(403)
    expect((await call('/v1/host/secrets', 'aud-prod')).status).toBe(403)
    expect(await (await call('/v1/host/secrets', 'aud-host')).json()).toEqual({
      secrets: { POSTGRES_PASSWORD: 'host-pg' },
    })
    expect((await call('/v1/other/secrets', 'aud-prod')).status).toBe(404)
    const anonymous = await worker.fetch(new Request('https://config.example/v1/prod/secrets'), env)
    expect(anonymous.status).toBe(403)
  })

  it('reads the per-deployment credentials from bootstrap.env', () => {
    const text = [
      '# comment',
      'CONFIG_CENTER_URL=https://config.example/',
      'PROD_CONFIG_ACCESS_CLIENT_ID=prod-id',
      'PROD_CONFIG_ACCESS_CLIENT_SECRET=prod-secret',
    ].join('\n')
    expect(bootstrapFor(text, 'prod')).toEqual({
      url: 'https://config.example',
      id: 'prod-id',
      secret: 'prod-secret',
    })
    expect(() => bootstrapFor(text, 'test')).toThrow('TEST_CONFIG_ACCESS_CLIENT_ID')
    // 宿主机级密钥用 prod 的 token。
    expect(bootstrapFor(text, 'host').id).toBe('prod-id')
  })
})
