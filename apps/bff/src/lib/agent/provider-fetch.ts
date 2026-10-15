import { publicFetchTarget, SafeFetchError } from '../safeFetch'
import type { AgentFetch } from './model'

/** Never send a provider credential to an alternate origin or follow an upstream redirect. */
export function providerFetch(fetch: AgentFetch, baseUrl: string): AgentFetch {
  const origin = new URL(baseUrl).origin
  return async (input, init) => {
    if (input instanceof Request) {
      // Keep the effective request intact when replacing only its network target.
      // In particular, leave an inherited body as a stream so guardedAgentFetch rejects it.
      init = {
        cache: input.cache,
        credentials: input.credentials,
        integrity: input.integrity,
        keepalive: input.keepalive,
        mode: input.mode,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        ...init,
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body ?? input.body,
        signal: init?.signal ?? input.signal,
      }
    }
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
