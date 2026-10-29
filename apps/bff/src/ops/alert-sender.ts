import type { AlertMessage } from '@image-playground/shared'

/**
 * 把告警推出去：飞书群机器人，外加可选的通用 JSON webhook（接自己的值班系统、IM 机器人或中转服务）。
 * 地址和请求头等同于密钥：只从部署配置来，不进日志、不进报错。
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
const TIMEOUT_MS = 10_000

function roundText(messages: AlertMessage[], deployment: string): string {
  return messages
    .map((message) => `${MARK[message.kind]}【${deployment}】${message.text}`)
    .join('\n')
}

/** fetch 自己的报错会带上地址（`Failed to parse URL from …`），而调用方会把报错写进日志。 */
function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (current, secret) => (secret ? current.replaceAll(secret, '<redacted>') : current),
    text,
  )
}

function requestFailed(error: unknown, secrets: string[], label: string): Error {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return new Error(`${label} request failed: ${redact(reason, secrets)}`)
}

export function createAlertSender(options: AlertSenderOptions): AlertSender {
  const url = options.webhookUrl?.trim()
  const fetchImpl = options.fetchImpl ?? fetch
  return async (messages) => {
    if (!url || messages.length === 0) return
    // 一轮的几条告警并成一条消息发：逐条发的话，发到一半失败，调用方只知道「这轮没发成」，
    // 下一轮会把已经送达的那几条再发一遍。
    const text = roundText(messages, options.deployment)
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw requestFailed(error, [url], 'alert webhook')
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

interface JsonWebhookOptions {
  /** 一个或多个接收地址；空列表就什么都不做。 */
  urls: string[]
  /** 每个请求都带上的请求头，比如 `Authorization: Bearer …`。 */
  headers?: Record<string, string>
  deployment: string
  fetchImpl?: typeof fetch
  now?: () => Date
}

/** 通用 JSON webhook 收到的请求体。字段只增不改，接收方可以放心按名字取。 */
export interface JsonAlertPayload {
  source: 'muvloom-ops'
  deployment: string
  sent_at: string
  /** 这一轮全是告警、全是恢复，还是都有。 */
  status: 'firing' | 'resolved' | 'mixed'
  /** 和飞书群里那条一样的整段文字，接收方只想转发文字时直接用。 */
  text: string
  alerts: Array<{
    rule: AlertMessage['rule']
    kind: AlertMessage['kind']
    text: string
    detail?: AlertMessage['detail']
  }>
}

export function jsonAlertPayload(
  messages: AlertMessage[],
  deployment: string,
  now: Date,
): JsonAlertPayload {
  const kinds = new Set(messages.map((message) => message.kind))
  return {
    source: 'muvloom-ops',
    deployment,
    sent_at: now.toISOString(),
    status: kinds.size > 1 ? 'mixed' : (messages[0]?.kind ?? 'firing'),
    text: roundText(messages, deployment),
    alerts: messages.map((message) => ({
      rule: message.rule,
      kind: message.kind,
      text: message.text,
      ...(message.detail ? { detail: message.detail } : {}),
    })),
  }
}

/** 每个地址各发一次；任何一个没送到就抛出，报错里不出现地址和请求头的值。 */
export function createJsonWebhookSender(options: JsonWebhookOptions): AlertSender {
  const urls = options.urls.map((url) => url.trim()).filter(Boolean)
  const headers = options.headers ?? {}
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => new Date())
  const secrets = [...urls, ...Object.values(headers)]
  return async (messages) => {
    if (urls.length === 0 || messages.length === 0) return
    const body = JSON.stringify(jsonAlertPayload(messages, options.deployment, now()))
    const results = await Promise.allSettled(
      urls.map(async (url, index) => {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }).catch((error: unknown) => {
          throw requestFailed(error, secrets, `json alert webhook #${index + 1}`)
        })
        if (!response.ok) {
          throw new Error(`json alert webhook #${index + 1} answered ${response.status}`)
        }
      }),
    )
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [String((result.reason as Error).message)] : [],
    )
    if (failures.length > 0) throw new Error(failures.join('; '))
  }
}

/**
 * 解析 `OPS_ALERT_WEBHOOK_HEADERS`：一个值全是字符串的 JSON 对象。
 * 格式不对时抛出的报错只说哪里不对，不回显内容（里面可能就是令牌）。
 */
export function parseWebhookHeaders(raw: string | undefined): Record<string, string> {
  const text = raw?.trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('OPS_ALERT_WEBHOOK_HEADERS is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OPS_ALERT_WEBHOOK_HEADERS must be a JSON object')
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`OPS_ALERT_WEBHOOK_HEADERS.${name} must be a string`)
    }
    headers[name] = value
  }
  return headers
}

export function parseWebhookUrls(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter(Boolean)
}

type AlertEnv = Record<string, string | undefined>

/** 有没有任何一个出口配上了：写进 worker 心跳，看板据此提示「告警没接」。 */
export function alertTargetsConfigured(env: AlertEnv = process.env): boolean {
  return (
    Boolean(env.OPS_ALERT_WEBHOOK_URL?.trim()) ||
    parseWebhookUrls(env.OPS_ALERT_WEBHOOK_URLS).length > 0
  )
}

interface EnvSenderOptions {
  deployment: string
  env?: AlertEnv
  fetchImpl?: typeof fetch
  /** 有出口送到了、但别的出口没送到时调；不抛出，免得送到的那边下一轮被重复推送。 */
  onPartialFailure?: (error: Error) => void
}

/**
 * 按部署配置组好告警出口：飞书（OPS_ALERT_WEBHOOK_URL）和 JSON webhook（OPS_ALERT_WEBHOOK_URLS +
 * OPS_ALERT_WEBHOOK_HEADERS）各自独立。都没配就什么都不做；只配了飞书时行为和原来完全一样。
 * 所有出口都没送到才抛出（调用方下一轮重试）；送到了一部分只报给 onPartialFailure。
 */
export function createAlertSenderFromEnv(options: EnvSenderOptions): AlertSender {
  const env = options.env ?? process.env
  const targets: Array<{ name: string; send: AlertSender }> = []
  if (env.OPS_ALERT_WEBHOOK_URL?.trim()) {
    targets.push({
      name: 'feishu',
      send: createAlertSender({
        webhookUrl: env.OPS_ALERT_WEBHOOK_URL,
        deployment: options.deployment,
        fetchImpl: options.fetchImpl,
      }),
    })
  }
  const urls = parseWebhookUrls(env.OPS_ALERT_WEBHOOK_URLS)
  if (urls.length > 0) {
    let send: AlertSender
    try {
      send = createJsonWebhookSender({
        urls,
        headers: parseWebhookHeaders(env.OPS_ALERT_WEBHOOK_HEADERS),
        deployment: options.deployment,
        fetchImpl: options.fetchImpl,
      })
    } catch (error) {
      // 请求头写错了也别连累飞书：这个出口每轮都报同一个配置错误。
      const configError = error as Error
      send = async () => {
        throw configError
      }
    }
    targets.push({ name: 'json', send })
  }
  const onPartialFailure =
    options.onPartialFailure ??
    ((error: Error) =>
      console.warn(
        JSON.stringify({ level: 'warn', event: 'ops.alert_target_failed', err: error.message }),
      ))
  if (targets.length === 0) return async () => {}
  if (targets.length === 1) return targets[0]!.send
  return async (messages) => {
    if (messages.length === 0) return
    const results = await Promise.allSettled(targets.map((target) => target.send(messages)))
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`${targets[index]!.name}: ${(result.reason as Error).message}`]
        : [],
    )
    if (failures.length === 0) return
    const error = new Error(failures.join('; '))
    if (failures.length === targets.length) throw error
    onPartialFailure(error)
  }
}
