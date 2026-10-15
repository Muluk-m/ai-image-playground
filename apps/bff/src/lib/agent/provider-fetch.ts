import { publicFetchTarget, SafeFetchError } from '../safeFetch'
import type { AgentFetch } from './model'

/** Never send a provider credential to an alternate origin or follow an upstream redirect. */
export function providerFetch(fetch: AgentFetch, baseUrl: string): AgentFetch {
  const origin = new URL(baseUrl).origin
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).origin !== origin)
      throw new SafeFetchError('blocked_url', 'Provider 请求地址与配置不一致')
    const target = await publicFetchTarget(url)
    const headers = new Headers(init?.headers)
    headers.set('host', target.host)
    const options: RequestInit & { tls: { serverName: string } } = {
      ...init,
      headers,
      redirect: 'manual',
      tls: { serverName: target.serverName },
    }
    const response = await fetch(target.url, options)
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new SafeFetchError('blocked_url', 'Provider API 不允许重定向，请配置最终地址')
    }
    return response
  }
}
