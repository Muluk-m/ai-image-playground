import { describe, expect, it } from 'bun:test'
import type { AlertMessage } from '@image-playground/shared'
import { createAlertSender } from '../../ops/alert-sender'

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
