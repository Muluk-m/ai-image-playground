import { createHash } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentMessageView } from '@image-playground/shared'
import { log } from '../logger'
import { objectStore } from '../objectStore'
import { isObject } from '../type-guards'
import { type CompactionSettings, compactionBudget, contextSizeTokens } from './compaction'
import type { AgentHistoryWindow } from './conversations'

const MAX_BYTES = 8 * 1024 * 1024
const READ_TIMEOUT_MS = 1_500
const WRITE_TIMEOUT_MS = 5_000
const keyOf = (conversationId: string) => `agent/${conversationId}/model-context-v1.json`

/** JSONB 会重排对象字段；字段顺序不应使同一份业务历史失效。 */
export function modelHistoryFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        isObject(item) && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex')
}

/** 选区是请求级授权，旧轮标记不得因恢复原生记录而重新进入下一轮。 */
export function canRetainModelHistory(history: AgentHistoryWindow): boolean {
  return (
    history.coveredCount === 0 &&
    !history.compaction.summary &&
    history.messages.every((message) =>
      message.content.every(
        (block) =>
          block.type !== 'text' ||
          (block.references ?? []).every(
            (reference) =>
              !('mask' in reference && reference.mask) &&
              !('regions' in reference && reference.regions?.length) &&
              !('editAction' in reference && reference.editAction),
          ),
      ),
    )
  )
}

const nonnegative = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

function usageValid(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.cost)) return false
  const cost = value.cost
  return (
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every((key) =>
      nonnegative(value[key]),
    ) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every((key) => nonnegative(cost[key]))
  )
}

/** 缓存并非受信任的状态机：只接受完整的原生消息与已经配齐的工具调用。 */
function isCompleteHistory(value: unknown): value is AgentMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_048) return false
  const pending = new Map<string, string>()
  const seen = new Set<string>()
  for (const message of value) {
    if (!isObject(message) || !nonnegative(message.timestamp)) return false
    if (!['user', 'assistant', 'toolResult'].includes(String(message.role))) return false
    if (message.role !== 'toolResult' && pending.size) return false
    if (message.role === 'user' && typeof message.content === 'string') continue
    if (!Array.isArray(message.content)) return false
    for (const block of message.content) {
      if (!isObject(block)) return false
      if (block.type === 'text' && typeof block.text === 'string') continue
      if (
        message.role !== 'assistant' &&
        block.type === 'image' &&
        typeof block.data === 'string' &&
        typeof block.mimeType === 'string'
      )
        continue
      if (message.role !== 'assistant') return false
      if (block.type === 'thinking' && typeof block.thinking === 'string') continue
      if (
        block.type !== 'toolCall' ||
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        !isObject(block.arguments) ||
        seen.has(block.id)
      )
        return false
      seen.add(block.id)
      pending.set(block.id, block.name)
    }
    if (message.role === 'assistant') {
      if (
        !['stop', 'toolUse'].includes(String(message.stopReason)) ||
        !['api', 'provider', 'model'].every((key) => typeof message[key] === 'string') ||
        !usageValid(message.usage)
      )
        return false
    } else if (message.role === 'toolResult') {
      if (
        typeof message.toolCallId !== 'string' ||
        typeof message.toolName !== 'string' ||
        typeof message.isError !== 'boolean' ||
        pending.get(message.toolCallId) !== message.toolName
      )
        return false
      pending.delete(message.toolCallId)
    }
  }
  return pending.size === 0 && value.at(-1)?.role !== 'user'
}

export interface ModelHistoryIdentity {
  readonly conversationId: string
  /** 当前模型、provider、system、工具声明与会话归属；不含密钥。 */
  readonly signature: string
  readonly history: readonly AgentMessageView[]
  readonly skillTexts?: ReadonlyMap<string, string>
}

const skillFingerprint = (texts: ModelHistoryIdentity['skillTexts']) =>
  modelHistoryFingerprint([...(texts ?? [])].sort(([a], [b]) => a.localeCompare(b)))

/** 新读的技能须与实际返回一致；本轮中途修改/删除正文不能钉成一个貌似有效的缓存。 */
export function modelHistorySkillsMatch(
  messages: readonly AgentMessage[],
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): boolean {
  const currentBodies = new Set(current.values())
  if ([...previous.values()].some((body) => !currentBodies.has(body))) return false
  if (
    messages.some(
      (message) =>
        message.role === 'toolResult' &&
        message.toolName === 'loadSkill' &&
        (message.content.length !== 1 ||
          message.content[0]?.type !== 'text' ||
          !currentBodies.has(message.content[0].text)),
    )
  )
    return false
  return [...current].every(
    ([id, text]) =>
      previous.get(id) === text ||
      messages.some(
        (message) =>
          message.role === 'toolResult' &&
          message.toolName === 'loadSkill' &&
          message.toolCallId === id &&
          message.content.length === 1 &&
          message.content[0]?.type === 'text' &&
          message.content[0].text === text,
      ),
  )
}

/** 必须在会话确权之后、预扣之前调用。故障只丢缓存，不改变产品历史。 */
export async function readModelHistory(
  identity: ModelHistoryIdentity,
): Promise<AgentMessage[] | undefined> {
  if (identity.history.length === 0) return undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = async () => {
      const object = await objectStore().open(keyOf(identity.conversationId))
      if (expired || object.size <= 0 || object.size > MAX_BYTES) return undefined
      reader = object.stream(0, object.size - 1).getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const next = await reader.read()
        if (expired) return undefined
        if (next.done) break
        size += next.value.byteLength
        if (size > MAX_BYTES) return undefined
        chunks.push(next.value)
      }
      const bytes = Buffer.concat(chunks)
      const snapshot: unknown = JSON.parse(bytes.toString('utf8'))
      if (
        !isObject(snapshot) ||
        snapshot.version !== 1 ||
        snapshot.signature !== identity.signature ||
        snapshot.history !== modelHistoryFingerprint(identity.history) ||
        snapshot.skills !== skillFingerprint(identity.skillTexts) ||
        !isCompleteHistory(snapshot.messages)
      )
        return undefined
      return snapshot.messages
    }
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve(undefined)
        }, READ_TIMEOUT_MS)
      }),
    ])
  } catch {
    // 首次使用、对象过期与存储故障都可以走已有回放；不记录原始会话或图片。
    return undefined
  } finally {
    clearTimeout(timer)
    void reader?.cancel().catch(() => {})
  }
}

/** 单会话单个有界对象；与参考图一起随会话清理，不在数据库重复存 base64。 */
export async function writeModelHistory(
  identity: ModelHistoryIdentity,
  messages: AgentMessage[],
): Promise<void> {
  if (!isCompleteHistory(messages)) return
  const serialized = JSON.stringify({
    version: 1,
    signature: identity.signature,
    history: modelHistoryFingerprint(identity.history),
    skills: skillFingerprint(identity.skillTexts),
    // details 供应用回显，不送 provider；去掉它以免复制任务内部状态。
    messages: messages.map((message) =>
      message.role === 'toolResult' ? { ...message, details: undefined } : message,
    ),
  })
  // 旧工具参数也可能含选区绑定；这种会话继续采用现有按作用域回放的路径。
  if (serialized.includes('selection_') || Buffer.byteLength(serialized) > MAX_BYTES) return
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const writing = objectStore().write(
      keyOf(identity.conversationId),
      Buffer.from(serialized),
      'application/json',
      controller.signal,
    )
    await Promise.race([
      writing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('Model history upload deadline exceeded'))
          reject(controller.signal.reason)
        }, WRITE_TIMEOUT_MS)
      }),
    ])
  } catch {
    log.warn(
      { event: 'agent.model_history_write_failed', conversationId: identity.conversationId },
      'model history cache unavailable; next turn will replay product history',
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pi 的 transform 不修改内部原始 messages。超过预算之后，每次都替换同一段原始前缀，
 * 然后交现有压缩器，使它的 UI 消息位置与持久锚点继续一一对应。
 */
export function modelHistoryTransform(input: {
  readonly nativePrefixLength: number
  readonly replay: AgentMessage[]
  readonly settings: CompactionSettings
  readonly overheadTokens: number
  readonly compact: (messages: AgentMessage[]) => Promise<AgentMessage[]>
}) {
  let fellBack = false
  return {
    reusable: () => !fellBack,
    transform: async (messages: AgentMessage[]) => {
      if (
        !fellBack &&
        contextSizeTokens(messages, input.overheadTokens) <=
          compactionBudget(input.settings).threshold
      )
        return messages
      fellBack = true
      return input.compact([...input.replay, ...messages.slice(input.nativePrefixLength)])
    },
  }
}
