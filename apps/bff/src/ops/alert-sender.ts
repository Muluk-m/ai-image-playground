import type { AlertMessage } from '@image-playground/shared'

/**
 * 把告警推到运营者的飞书群。地址等同于密钥：只从部署配置来，不进日志、不进报错。
 * 刻意不 import 后端的 config，采集容器也要用它。
 */

export type AlertSender = (messages: AlertMessage[]) => Promise<void>

interface AlertSenderOptions {
  /** 飞书群机器人的 webhook；没配就安静地什么都不做，自部署的人不配也不会报错。 */
  webhookUrl: string | undefined
  /** 写进每条消息，两套部署推到同一个群时分得清是谁。 */
  deployment: string
  fetchImpl?: typeof fetch
}

const MARK = { firing: '🔴', resolved: '🟢' } as const

export function createAlertSender(options: AlertSenderOptions): AlertSender {
  const url = options.webhookUrl?.trim()
  const fetchImpl = options.fetchImpl ?? fetch
  return async (messages) => {
    if (!url || messages.length === 0) return
    // 一轮的几条告警并成一条消息发：逐条发的话，发到一半失败，调用方只知道「这轮没发成」，
    // 下一轮会把已经送达的那几条再发一遍。
    const text = messages
      .map((message) => `${MARK[message.kind]}【${options.deployment}】${message.text}`)
      .join('\n')
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      // fetch 自己的报错会带上地址（`Failed to parse URL from …`），而调用方会把报错写进日志。
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      throw new Error(`alert webhook request failed: ${reason.replaceAll(url, '<webhook>')}`)
    })
    if (!response.ok) throw new Error(`alert webhook answered ${response.status}`)
    // 被关键词或签名校验拦下的消息，飞书回的是 200，错误在 body 里。
    const body = (await response.json().catch(() => null)) as {
      code?: number
      msg?: string
    } | null
    if (body && typeof body.code === 'number' && body.code !== 0) {
      throw new Error(`alert webhook refused the message: ${body.code} ${body.msg ?? ''}`.trim())
    }
  }
}
