import { afterEach, describe, expect, it } from 'bun:test'
import {
  _setSafeFetchForTesting,
  isPublicAddress,
  SafeFetchError,
  safeFetch,
} from '../../lib/safeFetch'

interface Recorded {
  readonly url: string
  readonly host: string | null
  readonly serverName: string | undefined
}

/** 主机名 → 解析结果；传输层按「钉住的 IP + Host 头」回应。 */
function install(
  records: Readonly<Record<string, readonly string[]>>,
  respond: (host: string, path: string) => Response,
): Recorded[] {
  const calls: Recorded[] = []
  _setSafeFetchForTesting({
    resolve: async (hostname) => {
      const addresses = records[hostname]
      if (!addresses) throw new Error(`ENOTFOUND ${hostname}`)
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    },
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      const host = headers.get('host')
      calls.push({ url, host, serverName: init.tls?.serverName })
      return respond(host ?? '', new URL(url).pathname)
    },
  })
  return calls
}

async function failure(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SafeFetchError) return error
    throw error
  }
  throw new Error('expected SafeFetchError')
}

const OPTIONS = { maxBytes: 1024, timeoutMs: 5_000 }

afterEach(() => _setSafeFetchForTesting())

describe('isPublicAddress', () => {
  it('拒绝内网、回环、链路本地、云元数据与嵌着 IPv4 的 IPv6 写法', () => {
    for (const address of [
      '127.0.0.1',
      '10.2.3.4',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '64:ff9b::a00:1',
    ]) {
      expect(isPublicAddress(address)).toBe(false)
    }
    expect(isPublicAddress('93.184.215.14')).toBe(true)
    expect(isPublicAddress('2606:4700::6810:84e5')).toBe(true)
    expect(isPublicAddress('not-an-ip')).toBe(false)
  })
})

describe('safeFetch', () => {
  it('连接钉在验过的 IP 上，Host 头与 TLS serverName 仍是原主机名', async () => {
    const calls = install({ 'shop.example': ['93.184.215.14'] }, () => new Response('hello'))
    const result = await safeFetch('https://shop.example/item?id=1', OPTIONS)
    expect(new TextDecoder().decode(result.bytes)).toBe('hello')
    expect(result.finalUrl).toBe('https://shop.example/item?id=1')
    expect(calls).toEqual([
      { url: 'https://93.184.215.14/item?id=1', host: 'shop.example', serverName: 'shop.example' },
    ])
  })

  it('任何一条解析结果是内网就整个拒绝，不去连公网那条', async () => {
    const calls = install(
      { 'rebind.example': ['93.184.215.14', '127.0.0.1'] },
      () => new Response('x'),
    )
    const error = await failure(safeFetch('https://rebind.example/', OPTIONS))
    expect(error.code).toBe('blocked_url')
    expect(calls).toHaveLength(0)
  })

  it('IP 字面量、非 http 协议与带账号密码的地址直接拒绝', async () => {
    const calls = install({}, () => new Response('x'))
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]:8080/',
      'file:///etc/passwd',
      'https://user:pass@example.com/',
    ]) {
      expect((await failure(safeFetch(url, OPTIONS))).code).toBe('blocked_url')
    }
    expect(calls).toHaveLength(0)
  })

  it('重定向每一跳都重新验：跳去内网的那一跳被拦下', async () => {
    const calls = install(
      { 'cdn.example': ['93.184.215.14'], 'internal.example': ['10.0.0.5'] },
      () =>
        new Response(null, { status: 302, headers: { location: 'http://internal.example/admin' } }),
    )
    const error = await failure(safeFetch('https://cdn.example/a.png', OPTIONS))
    expect(error.code).toBe('blocked_url')
    expect(calls.map((call) => call.host)).toEqual(['cdn.example'])
  })

  it('相对重定向照原主机跟下去，finalUrl 是最后那一跳', async () => {
    install({ 'cdn.example': ['93.184.215.14'] }, (_host, path) =>
      path === '/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response('moved'),
    )
    const result = await safeFetch('https://cdn.example/old', OPTIONS)
    expect(result.finalUrl).toBe('https://cdn.example/new')
  })

  it('重定向超过上限就停', async () => {
    install(
      { 'loop.example': ['93.184.215.14'] },
      () => new Response(null, { status: 302, headers: { location: '/again' } }),
    )
    const error = await failure(safeFetch('https://loop.example/', { ...OPTIONS, maxRedirects: 2 }))
    expect(error.code).toBe('too_many_redirects')
  })

  it('边读边数：超过上限立即报 too_large，不信 content-length 缺席', async () => {
    install({ 'big.example': ['93.184.215.14'] }, () => {
      const chunk = new Uint8Array(600)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk)
            controller.enqueue(chunk)
            controller.close()
          },
        }),
      )
    })
    expect((await failure(safeFetch('https://big.example/', OPTIONS))).code).toBe('too_large')
  })

  it('非 2xx 带着状态码报 http_error', async () => {
    install({ 'gone.example': ['93.184.215.14'] }, () => new Response('nope', { status: 404 }))
    const error = await failure(safeFetch('https://gone.example/', OPTIONS))
    expect(error.code).toBe('http_error')
    expect(error.status).toBe(404)
  })
})
