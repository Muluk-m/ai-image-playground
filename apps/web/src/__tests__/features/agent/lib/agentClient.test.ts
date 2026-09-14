import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { describe, expect, it, vi } from 'vitest'

const DEVICE = 'device-abcdefgh'

vi.mock('../../../../lib/deviceId', () => ({ getDeviceId: () => DEVICE }))
vi.mock('../../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'https://bff.test' }))

import {
  fetchConversations,
  fetchMessages,
  resumeTurn,
} from '../../../../features/agent/lib/agentClient'

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** 只记请求，回一个空但形状对的响应；断言全落在请求上。 */
function recordingFetcher(body: unknown) {
  const calls: Call[] = []
  const fetcher = (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }
  return { calls, fetcher }
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

describe('agentClient 的设备标识传输位置', () => {
  it('列会话把设备标识放请求头，不放 query string', async () => {
    const { calls, fetcher } = recordingFetcher({ conversations: [] })

    await fetchConversations(fetcher)

    expect(calls[0]!.url).toBe('https://bff.test/api/agent/conversations')
    expect(headerOf(calls[0]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
  })

  it('读消息把设备标识放请求头，不放 query string', async () => {
    const { calls, fetcher } = recordingFetcher({ messages: [], turns: [], activeTurn: null })

    await fetchMessages('conv-1', fetcher)

    expect(calls[0]!.url).toBe('https://bff.test/api/agent/conversations/conv-1/messages')
    expect(headerOf(calls[0]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
  })

  it('续播把设备标识放请求头，并保留断点头', async () => {
    const { calls, fetcher } = recordingFetcher({})

    // 生成器是惰性的，得先拉一次才会发请求。
    await resumeTurn('conv-1', 'turn-1', 12, fetcher).next()

    expect(calls[0]!.url).toBe(
      'https://bff.test/api/agent/conversations/conv-1/turns/turn-1/events',
    )
    expect(headerOf(calls[0]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
    expect(headerOf(calls[0]!.init, 'last-event-id')).toBe('12')
  })
})
