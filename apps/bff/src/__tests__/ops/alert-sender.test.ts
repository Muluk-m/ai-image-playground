import { describe, expect, it } from 'bun:test'
import type { AlertMessage } from '@image-playground/shared'
import {
  alertTargetsConfigured,
  createAlertSender,
  createAlertSenderFromEnv,
  createJsonWebhookSender,
  parseWebhookHeaders,
} from '../../ops/alert-sender'

const firing: AlertMessage = {
  rule: 'disk',
  kind: 'firing',
  text: '磁盘已用 96%，只剩 2.0 GB（告警线 85%）',
}
const resolved: AlertMessage = { rule: 'disk', kind: 'resolved', text: '已恢复：磁盘已用 40%' }

function recorder(reply: () => Response = () => Response.json({ code: 0 })) {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return reply()
  }
  return { calls, fetchImpl: fetchImpl as typeof fetch }
}

describe('createAlertSender', () => {
  it('posts a round of alerts as one message, naming the deployment so two editions are not confused', async () => {
    const { calls, fetchImpl } = recorder()
    const send = createAlertSender({
      webhookUrl: 'https://hook.test/abc',
      deployment: 'paid',
      fetchImpl,
    })

    await send([firing, resolved])

    expect(calls).toEqual([
      {
        url: 'https://hook.test/abc',
        body: {
          msg_type: 'text',
          content: {
            text: '🔴【paid】磁盘已用 96%，只剩 2.0 GB（告警线 85%）\n🟢【paid】已恢复：磁盘已用 40%',
          },
        },
      },
    ])
  })

  it('stays silent and succeeds when no webhook is configured', async () => {
    const { calls, fetchImpl } = recorder()
    const send = createAlertSender({ webhookUrl: undefined, deployment: 'internal', fetchImpl })
    await send([firing])
    expect(calls).toEqual([])
  })

  it('reports a failed delivery to the caller: the group never saw it', async () => {
    const network = createAlertSender({
      webhookUrl: 'https://hook.test/abc',
      deployment: 'paid',
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND')
      }) as unknown as typeof fetch,
    })
    await expect(network([firing])).rejects.toThrow('ENOTFOUND')

    // 飞书对被关键词或签名拦下的消息回 200，错误在 body 的 code 里。
    const rejected = createAlertSender({
      webhookUrl: 'https://hook.test/abc',
      deployment: 'paid',
      fetchImpl: recorder(() => Response.json({ code: 19024, msg: 'Key Words Not Found' }))
        .fetchImpl,
    })
    await expect(rejected([firing])).rejects.toThrow('19024')
  })

  it('never puts the webhook address into an error', async () => {
    const send = createAlertSender({
      webhookUrl: 'https://hook.test/secret-token',
      deployment: 'paid',
      fetchImpl: recorder(() => new Response('nope', { status: 500 })).fetchImpl,
    })
    const error = await send([firing]).catch((thrown: Error) => thrown)
    expect(String(error)).not.toContain('secret-token')
  })

  it('keeps the address out of the error when the request itself fails', async () => {
    const send = createAlertSender({
      webhookUrl: 'https://hook.test/secret-token',
      deployment: 'paid',
      fetchImpl: (async (url: string | URL | Request) => {
        throw new TypeError(`Failed to parse URL from ${String(url)}`)
      }) as unknown as typeof fetch,
    })
    const error = await send([firing]).catch((thrown: Error) => thrown)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('secret-token')
    expect(String(error)).toContain('TypeError')
  })
})

describe('createJsonWebhookSender', () => {
  const now = () => new Date('2026-10-29T01:00:00.000Z')

  it('posts one JSON body per address with the configured headers', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      })
      return new Response('ok')
    }) as typeof fetch
    const send = createJsonWebhookSender({
      urls: ['https://a.test/hook', 'https://b.test/hook'],
      headers: { Authorization: 'Bearer t0ken' },
      deployment: 'paid',
      fetchImpl,
      now,
    })
    const detailed: AlertMessage = { ...firing, rule: 'generation', detail: { models: [] } }

    await send([detailed, resolved])

    expect(seen.map((call) => call.url)).toEqual(['https://a.test/hook', 'https://b.test/hook'])
    expect(seen[0]?.headers).toEqual({
      Authorization: 'Bearer t0ken',
      'content-type': 'application/json',
    })
    expect(seen[0]?.body).toEqual({
      source: 'muvloom-ops',
      deployment: 'paid',
      sent_at: '2026-10-29T01:00:00.000Z',
      status: 'mixed',
      text: '🔴【paid】磁盘已用 96%，只剩 2.0 GB（告警线 85%）\n🟢【paid】已恢复：磁盘已用 40%',
      alerts: [
        { rule: 'generation', kind: 'firing', text: firing.text, detail: { models: [] } },
        { rule: 'disk', kind: 'resolved', text: resolved.text },
      ],
    })
  })

  it('keeps addresses and header values out of errors', async () => {
    const send = createJsonWebhookSender({
      urls: ['https://a.test/secret-path'],
      headers: { Authorization: 'Bearer secret-token' },
      deployment: 'paid',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        throw new TypeError(`bad ${String(url)} ${JSON.stringify(init?.headers)}`)
      }) as unknown as typeof fetch,
    })
    const error = await send([firing]).catch((thrown: Error) => thrown)
    expect(String(error)).not.toContain('secret-path')
    expect(String(error)).not.toContain('secret-token')

    const refused = createJsonWebhookSender({
      urls: ['https://a.test/secret-path'],
      deployment: 'paid',
      fetchImpl: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch,
    })
    await expect(refused([firing])).rejects.toThrow('answered 401')
  })
})

describe('parseWebhookHeaders', () => {
  it('reads a JSON object of strings and never echoes the value on error', () => {
    expect(parseWebhookHeaders(undefined)).toEqual({})
    expect(parseWebhookHeaders('{"Authorization":"Bearer x"}')).toEqual({
      Authorization: 'Bearer x',
    })
    expect(() => parseWebhookHeaders('Bearer secret')).toThrow('not valid JSON')
    expect(() => parseWebhookHeaders('["secret"]')).toThrow('must be a JSON object')
    const error = (() => {
      try {
        parseWebhookHeaders('{"Authorization": 42}')
      } catch (thrown) {
        return thrown as Error
      }
    })()
    expect(error?.message).toBe('OPS_ALERT_WEBHOOK_HEADERS.Authorization must be a string')
  })
})

describe('createAlertSenderFromEnv', () => {
  function capture(failing: (url: string) => boolean = () => false) {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url))
      if (failing(String(url))) return new Response('down', { status: 502 })
      return Response.json({ code: 0 })
    }) as typeof fetch
    return { urls, fetchImpl }
  }

  it('sends nothing and succeeds when nothing is configured', async () => {
    const { urls, fetchImpl } = capture()
    await createAlertSenderFromEnv({ deployment: 'paid', env: {}, fetchImpl })([firing])
    expect(urls).toEqual([])
    expect(alertTargetsConfigured({})).toBe(false)
  })

  it('keeps the Feishu-only behaviour when only the Feishu address is set', async () => {
    const { urls, fetchImpl } = capture()
    const env = { OPS_ALERT_WEBHOOK_URL: 'https://feishu.test/hook' }
    await createAlertSenderFromEnv({ deployment: 'paid', env, fetchImpl })([firing])
    expect(urls).toEqual(['https://feishu.test/hook'])
    expect(alertTargetsConfigured(env)).toBe(true)
  })

  it('sends to both targets, and one failing target neither blocks nor repeats the other', async () => {
    const { urls, fetchImpl } = capture((url) => url.includes('json'))
    const partial: Error[] = []
    const env = {
      OPS_ALERT_WEBHOOK_URL: 'https://feishu.test/hook',
      OPS_ALERT_WEBHOOK_URLS: 'https://json.test/hook',
      OPS_ALERT_WEBHOOK_HEADERS: '{"Authorization":"Bearer secret-token"}',
    }
    const send = createAlertSenderFromEnv({
      deployment: 'paid',
      env,
      fetchImpl,
      onPartialFailure: (error) => partial.push(error),
    })

    await send([firing])

    expect(urls.sort()).toEqual(['https://feishu.test/hook', 'https://json.test/hook'])
    expect(partial).toHaveLength(1)
    expect(partial[0]?.message).toContain('json')
    expect(partial[0]?.message).not.toContain('secret-token')
  })

  it('throws when every configured target failed, so the round is retried', async () => {
    const { fetchImpl } = capture(() => true)
    const send = createAlertSenderFromEnv({
      deployment: 'paid',
      env: {
        OPS_ALERT_WEBHOOK_URL: 'https://feishu.test/hook',
        OPS_ALERT_WEBHOOK_URLS: 'https://json.test/hook',
      },
      fetchImpl,
      onPartialFailure: () => {},
    })
    await expect(send([firing])).rejects.toThrow('feishu')
  })

  it('does not let malformed headers break Feishu delivery', async () => {
    const { urls, fetchImpl } = capture()
    const partial: Error[] = []
    await createAlertSenderFromEnv({
      deployment: 'paid',
      env: {
        OPS_ALERT_WEBHOOK_URL: 'https://feishu.test/hook',
        OPS_ALERT_WEBHOOK_URLS: 'https://json.test/hook',
        OPS_ALERT_WEBHOOK_HEADERS: 'Bearer oops',
      },
      fetchImpl,
      onPartialFailure: (error) => partial.push(error),
    })([firing])
    expect(urls).toEqual(['https://feishu.test/hook'])
    expect(partial[0]?.message).toContain('not valid JSON')
    expect(partial[0]?.message).not.toContain('oops')
  })
})
