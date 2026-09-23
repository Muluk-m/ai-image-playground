import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { startDeadline } from './timeoutFetch'

/**
 * 服务端代智能体访问任意外网地址的唯一入口：抓网页、取网图都走这里。
 *
 * 地址是模型写的，模型又读过网页——两层都不可信，所以这一层只认公网：
 * 1. 只收 http / https，不收带账号密码的地址；
 * 2. 主机名先解析，**任何一条**解析结果落在内网、回环、链路本地（含云元数据 169.254.169.254）、
 *    保留段就整个拒绝；
 * 3. 连接钉在刚验过的那个 IP 上（TLS 仍按原主机名校验证书），解析与连接之间换不了地址；
 * 4. 重定向手动跟，每一跳重新走一遍上面三步；
 * 5. 字节边读边数，超过上限立即断开。
 *
 * Bun 的 `undici` 只是个壳，`Agent` 的 `connect.lookup` 不生效，所以钉 IP 用的是
 * 「URL 写 IP、Host 头与 TLS serverName 写原主机名」。
 */

export type SafeFetchErrorCode =
  | 'blocked_url'
  | 'too_many_redirects'
  | 'http_error'
  | 'too_large'
  | 'timeout'
  | 'network'

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SafeFetchError'
  }
}

export interface SafeFetchOptions {
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly accept?: string
  readonly maxRedirects?: number
}

export interface SafeFetchResponse {
  readonly bytes: Uint8Array
  /** 响应头里的 content-type，原样（可能带 charset）；没有就是空串。 */
  readonly contentType: string
  /** 跟完重定向之后真正取到字节的那个地址。 */
  readonly finalUrl: string
}

interface ResolvedAddress {
  readonly address: string
  readonly family: number
}
type Resolve = (hostname: string) => Promise<readonly ResolvedAddress[]>
type Transport = (
  url: string,
  init: RequestInit & { tls?: { serverName?: string } },
) => Promise<Response>

const DEFAULT_MAX_REDIRECTS = 3
const USER_AGENT = 'Mozilla/5.0 (compatible; MuvloomAgent/1.0; +https://muvloom.online)'

const defaultResolve: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true })
const defaultTransport: Transport = (url, init) => fetch(url, init)
let resolve = defaultResolve
let transport = defaultTransport

/** 测试注入点：DNS 与传输各自可换；不传即恢复真实实现。 */
export function _setSafeFetchForTesting(next?: {
  readonly resolve?: Resolve
  readonly fetch?: Transport
}): void {
  resolve = next?.resolve ?? defaultResolve
  transport = next?.fetch ?? defaultTransport
}

/**
 * 非公网段（RFC 6890 特殊用途地址表里不可全局路由的那些）。两族各一张表：Bun 的 BlockList
 * 查 IPv4 时会去匹配 `::ffff:0:0/96`，同表放着那条规则就会把所有 IPv4 当成被拦。
 */
const BLOCKED_V4 = subnets('ipv4', [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
// 嵌着 IPv4 的几种写法（映射、NAT64、6to4）一律拒：正常站点的 AAAA 不会是它们，
// 放过去就得逐种拆出内层地址再查一遍。
const BLOCKED_V6 = subnets('ipv6', [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
])

function subnets(
  family: 'ipv4' | 'ipv6',
  entries: readonly (readonly [string, number])[],
): BlockList {
  const list = new BlockList()
  for (const [network, prefix] of entries) list.addSubnet(network, prefix, family)
  return list
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !BLOCKED_V4.check(address, 'ipv4')
  if (family === 6) return !BLOCKED_V6.check(address, 'ipv6')
  return false
}

/** 地址本身能不能拿来抓：协议、账号密码。主机解析另算。 */
function parseTarget(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SafeFetchError('blocked_url', `不是合法的网址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('blocked_url', `只支持 http / https 网址：${raw}`)
  }
  if (url.username || url.password) {
    throw new SafeFetchError('blocked_url', '网址里不能带账号密码')
  }
  if (!url.hostname) throw new SafeFetchError('blocked_url', `网址缺少主机名：${raw}`)
  return url
}

/** 解析并挑一个能连的公网地址；任何一条解析结果不是公网就整个拒绝。 */
async function pinnedAddress(url: URL): Promise<string> {
  // URL 把 IPv6 字面量写成 `[::1]`，去掉方括号才认得出来。
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1')
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new SafeFetchError('blocked_url', '不能访问内网地址')
    return hostname
  }
  let addresses: readonly ResolvedAddress[]
  try {
    addresses = await resolve(hostname)
  } catch (error) {
    throw new SafeFetchError('network', `无法解析域名 ${hostname}`, undefined, { cause: error })
  }
  if (addresses.length === 0) throw new SafeFetchError('network', `无法解析域名 ${hostname}`)
  if (!addresses.every((entry) => isPublicAddress(entry.address))) {
    throw new SafeFetchError('blocked_url', `${hostname} 指向内网地址，不能访问`)
  }
  return addresses[0]!.address
}

function pinnedUrl(url: URL, address: string): string {
  const pinned = new URL(url.href)
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address
  return pinned.href
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    throw new SafeFetchError('too_large', `内容超过 ${maxBytes} 字节上限`)
  }
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > maxBytes) throw new SafeFetchError('too_large', `内容超过 ${maxBytes} 字节上限`)
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export async function safeFetch(
  raw: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResponse> {
  const deadline = startDeadline(options.timeoutMs, options.signal)
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  try {
    let url = parseTarget(raw)
    for (let hop = 0; ; hop++) {
      const address = await pinnedAddress(url)
      let response: Response
      try {
        response = await transport(pinnedUrl(url, address), {
          method: 'GET',
          redirect: 'manual',
          signal: deadline.signal,
          headers: {
            Host: url.host,
            'User-Agent': USER_AGENT,
            Accept: options.accept ?? '*/*',
          },
          ...(url.protocol === 'https:' ? { tls: { serverName: url.hostname } } : {}),
        })
      } catch (error) {
        if (deadline.timedOut)
          throw new SafeFetchError('timeout', '请求超时', undefined, { cause: error })
        if (options.signal?.aborted) throw error
        throw new SafeFetchError('network', `连接 ${url.host} 失败`, undefined, { cause: error })
      }
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new SafeFetchError('http_error', '重定向缺少目标地址', response.status)
        if (hop >= maxRedirects) {
          throw new SafeFetchError('too_many_redirects', `重定向超过 ${maxRedirects} 次`)
        }
        url = parseTarget(new URL(location, url).href)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new SafeFetchError('http_error', `对方返回 HTTP ${response.status}`, response.status)
      }
      try {
        const bytes = await readCapped(response, options.maxBytes)
        return {
          bytes,
          contentType: response.headers.get('content-type') ?? '',
          finalUrl: url.href,
        }
      } catch (error) {
        if (error instanceof SafeFetchError) throw error
        if (deadline.timedOut)
          throw new SafeFetchError('timeout', '读取超时', undefined, { cause: error })
        if (options.signal?.aborted) throw error
        throw new SafeFetchError('network', '读取内容时连接中断', undefined, { cause: error })
      }
    }
  } finally {
    deadline.release()
  }
}
