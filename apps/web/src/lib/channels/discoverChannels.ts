/**
 * Channel discovery 客户端。在 runtimeConfig.bff.enabled=true 时 boot 调用，
 * 拉取 BFF 的 `/api/channels`（同源时 base 为空字符串，跨域时填 cf tunnel 域名）。
 *
 * 错误处理：网络错 / 非 200 / 响应不符合 schema 都向上抛，由 boot 层落到
 * console.warn + 空 channel 列表（UI 自动退化为「仅 BYOK 可用」）。
 *
 * 调用方应该传 `signal`（main.tsx 用 AbortSignal.timeout）— BFF hang 时不能
 * 让浏览器吊着 default ~5min 才放弃，否则 SPA 卡在白屏。
 */
import type { ChannelDiscoveryResponse, DiscoveredChannel } from '@image-playground/shared'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

export async function fetchDiscoveredChannels(
  bffBaseUrl: string,
  options: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<DiscoveredChannel[]> {
  const { fetcher = fetch, signal } = options
  const base = bffBaseUrl.replace(/\/+$/, '')
  const url = `${base}/api/channels`
  const res = await fetcher(url, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  const json = (await res.json()) as ChannelDiscoveryResponse
  if (!json || !Array.isArray(json.channels))
    throw new Error(`${url} response missing 'channels' array`)
  return json.channels
}
