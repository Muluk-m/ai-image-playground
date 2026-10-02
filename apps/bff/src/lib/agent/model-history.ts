import { createHash } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentMessageView, AgentMode, AgentThinkingDepth } from '@image-playground/shared'
import { canonicalJson } from '../canonicalJson'
import { log } from '../logger'
import { objectStore, readObjectWithinLimit } from '../objectStore'
import type { TaskOutcome } from '../private-overlay'
import { isObject } from '../type-guards'
import { type CompactionSettings, compactionBudget, contextSizeTokens } from './compaction'
import type { AgentContextTransform } from './compaction-transform'
import { type AgentHistoryWindow, type AgentOwner, listAgentHistoryWindow } from './conversations'
import { ConversationExecutionLost } from './execution'
import { type AgentTurnAudience, visibleAgentSkills } from './skills'
import { estimateMessageTokens } from './token-estimate'
import { agentToolDeclarations } from './tools'
import { replayedSkillTexts } from './tools/loadSkill'
import { systemPrompt } from './turn-input'

const MAX_BYTES = 8 * 1024 * 1024
const READ_TIMEOUT_MS = 1_500
/** 轮后保存的总期限：重读产品历史、核对技能与上传共用这一份。 */
const SAVE_TIMEOUT_MS = 5_000
const keyOf = (conversationId: string) => `agent/${conversationId}/model-context-v1.json`

/** JSONB 会重排对象字段；字段顺序不应使同一份业务历史失效。 */
export function modelHistoryFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** 存储与数据库不一定响应取消：到期即不再等待，迟到的写入会被历史指纹拒绝。 */
async function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  let stop = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

const SELECTION_FIELDS = ['mask', 'maskMediaId', 'maskDataUrl', 'regions', 'editAction'] as const

/** 选区是请求级授权：带选区的引用不论存储形态（遮罩、遮罩媒体、区域、编辑动作）都不进缓存。 */
export function referenceCarriesSelection(reference: object): boolean {
  return SELECTION_FIELDS.some((field) => {
    const value: unknown = Reflect.get(reference, field)
    return Array.isArray(value) ? value.length > 0 : !!value
  })
}

/** 工具参数里绑定的选区 ID（如 editImage 的 selectionBindings / deferredEdits）。 */
function bindsSelection(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(bindsSelection)
  if (!isObject(value)) return false
  return Object.entries(value).some(
    ([key, item]) =>
      (key === 'selectionId' && typeof item === 'string' && item !== '') || bindsSelection(item),
  )
}

/** 旧轮的选区标记不得因恢复原生记录而重新进入下一轮。 */
export function canRetainModelHistory(history: AgentHistoryWindow): boolean {
  return (
    history.coveredCount === 0 &&
    !history.compaction.summary &&
    history.messages.every((message) =>
      message.content.every(
        (block) =>
          block.type !== 'text' || !(block.references ?? []).some(referenceCarriesSelection),
      ),
    )
  )
}

/** 当前模型、provider、system、工具声明、技能目录与会话归属；不含密钥。 */
export function modelHistorySignature(input: {
  readonly conversationId: string
  readonly owner: AgentOwner
  readonly model: {
    readonly id: string
    readonly api: string
    readonly provider: string
    readonly baseUrl: string
  }
  readonly thinkingDepth?: AgentThinkingDepth
  readonly mode: AgentMode
  readonly autoSubmit: boolean
  readonly audience: AgentTurnAudience
}): string {
  const { conversationId, owner, model, thinkingDepth, mode, autoSubmit, audience } = input
  return modelHistoryFingerprint({
    conversationId,
    owner,
    model: { id: model.id, api: model.api, provider: model.provider, baseUrl: model.baseUrl },
    thinkingDepth,
    system: systemPrompt(mode, autoSubmit, audience),
    tools: agentToolDeclarations(mode, audience),
    skills: visibleAgentSkills(mode, audience)
      .map(({ name, content }) => ({ name, content }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
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
      // JSON 丢失视觉工作集的证据与释放身份；旧缓存也必须退回产品文字历史。
      if (block.type === 'image') return false
      if (message.role !== 'assistant') return false
      if (block.type === 'thinking' && typeof block.thinking === 'string') continue
      if (
        block.type !== 'toolCall' ||
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        !isObject(block.arguments) ||
        // 工具参数里的选区绑定同样是请求级授权；这种会话继续按作用域回放。
        bindsSelection(block.arguments) ||
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

interface ModelHistoryKey {
  readonly conversationId: string
  /** 见 {@link modelHistorySignature}。 */
  readonly signature: string
  readonly skillTexts?: ReadonlyMap<string, string>
}

const skillFingerprint = (texts: ModelHistoryKey['skillTexts']) =>
  modelHistoryFingerprint(Object.fromEntries(texts ?? []))

/** 新读的技能须与实际返回一致；本轮中途修改/删除正文不能钉成一个貌似有效的缓存。 */
export function modelHistorySkillsMatch(
  messages: readonly AgentMessage[],
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): boolean {
  // 单一文字块之外的返回记为 undefined：它不可能等于任何技能正文。
  const loaded = new Map<string, string | undefined>()
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'loadSkill') continue
    const [only] = message.content
    loaded.set(
      message.toolCallId,
      message.content.length === 1 && only?.type === 'text' ? only.text : undefined,
    )
  }
  const currentBodies = new Set(current.values())
  if ([...previous.values()].some((body) => !currentBodies.has(body))) return false
  if ([...loaded.values()].some((body) => body === undefined || !currentBodies.has(body)))
    return false
  return [...current].every(([id, text]) => previous.get(id) === text || loaded.get(id) === text)
}

/** 必须在会话确权之后、预扣之前调用。故障只丢缓存，不改变产品历史。 */
export async function readModelHistory(
  identity: ModelHistoryKey & { readonly history: readonly AgentMessageView[] },
): Promise<AgentMessage[] | undefined> {
  if (identity.history.length === 0) return undefined
  try {
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
    const bytes = await untilAborted(
      signal,
      readObjectWithinLimit(objectStore(), keyOf(identity.conversationId), MAX_BYTES, signal),
    )
    const snapshot: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (
      !isObject(snapshot) ||
      snapshot.version !== 1 ||
      snapshot.signature !== identity.signature ||
      snapshot.history !== modelHistoryFingerprint(identity.history) ||
      snapshot.skills !== skillFingerprint(identity.skillTexts) ||
      !isCompleteHistory(snapshot.messages)
    )
      return undefined
    // 估算失败必须在缓存边界内回退，不让缓存影响本轮可用性。
    if (snapshot.messages.some((message) => !Number.isFinite(estimateMessageTokens(message))))
      return undefined
    return snapshot.messages
  } catch {
    // 首次使用、对象过期与存储故障都可以走已有回放；不记录原始会话或图片。
    return undefined
  }
}

/** 单会话单个有界对象；与参考图一起随会话清理，不在数据库重复存 base64。不合格的历史直接放弃。 */
export async function writeModelHistory(
  identity: ModelHistoryKey & { readonly historyFingerprint: string },
  messages: readonly AgentMessage[],
  signal: AbortSignal,
): Promise<void> {
  if (!isCompleteHistory(messages)) return
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      signature: identity.signature,
      history: identity.historyFingerprint,
      skills: skillFingerprint(identity.skillTexts),
      // details 供应用回显，不送 provider；去掉它以免复制任务内部状态。
      messages: messages.map((message) =>
        message.role === 'toolResult' ? { ...message, details: undefined } : message,
      ),
    }),
  )
  if (bytes.byteLength > MAX_BYTES) return
  await untilAborted(
    signal,
    objectStore().write(keyOf(identity.conversationId), bytes, 'application/json', signal),
  )
}

export interface ModelHistorySave {
  readonly outcome: TaskOutcome
  /** 本轮用了原生缓存路径；没有回退到压缩时 `reusable()` 为真。 */
  readonly retained?: { readonly signature: string; reusable(): boolean }
  /** 这一轮的用户消息已落库；唤醒与续跑没有，也不走缓存。 */
  readonly userMessageStored: boolean
  /** 有插话已落库却没交到模型手里：产品历史与原生消息对不上。 */
  readonly steered: boolean
  readonly conversationId: string
  readonly turnId: string
  readonly owner: AgentOwner
  readonly mode: AgentMode
  readonly userId: string | null
  /** 起轮时的产品历史，接上本轮逐条写下的原貌。 */
  readonly expectedHistory: readonly AgentMessageView[]
  readonly previousSkills?: ReadonlyMap<string, string>
  readonly messages: readonly AgentMessage[]
  readonly assertExecution: () => Promise<void>
}

/**
 * 终帧之后、释放租约之前调用。重读产品历史与写入共用一个期限；任何不吻合或故障都只丢缓存，
 * 不影响已经结束的这一轮。
 */
export async function saveModelHistoryAfterTurn(save: ModelHistorySave): Promise<void> {
  const { conversationId, turnId } = save
  if (save.outcome !== 'completed') return
  if (!save.retained?.reusable()) return
  if (!save.userMessageStored) return
  if (save.steered) return
  try {
    const signal = AbortSignal.timeout(SAVE_TIMEOUT_MS)
    const current = await untilAborted(signal, listAgentHistoryWindow(conversationId, save.owner))
    if (!canRetainModelHistory(current)) return
    // 后台任务、确认卡或插话在本轮写下之后又改了消息：快照不再对应产品历史。
    const historyFingerprint = modelHistoryFingerprint(current.messages)
    if (historyFingerprint !== modelHistoryFingerprint(save.expectedHistory)) return
    const skillTexts = await untilAborted(
      signal,
      replayedSkillTexts(current.messages, save.mode, save.userId),
    )
    if (!modelHistorySkillsMatch(save.messages, save.previousSkills ?? new Map(), skillTexts)) {
      log.info(
        { event: 'agent.model_history_skills_changed', conversationId, turnId },
        'model history cache skipped after a skill changed',
      )
      return
    }
    await untilAborted(signal, save.assertExecution())
    await writeModelHistory(
      { conversationId, signature: save.retained.signature, historyFingerprint, skillTexts },
      save.messages,
      signal,
    )
  } catch (thrown) {
    // 租约已归别人：接手的一方自己决定缓存，这里安静放弃。
    if (thrown instanceof ConversationExecutionLost) return
    log.warn(
      { event: 'agent.model_history_save_failed', conversationId, turnId },
      'model history cache skipped; next turn will replay product history',
    )
  }
}

/**
 * Pi 的 transform 不修改内部原始 messages。超过预算之后，每次都替换同一段原始前缀，
 * 然后交现有压缩器，使它的 UI 消息位置与持久锚点继续一一对应。
 */
export function modelHistoryTransform(input: {
  readonly signature: string
  readonly nativePrefixLength: number
  /** 只在超出预算回退时才需要：正常路径不必把整段产品历史再回放一遍。 */
  readonly replay: () => AgentMessage[]
  readonly settings: CompactionSettings
  readonly overheadTokens: number
  readonly compact: AgentContextTransform
}) {
  let fellBack = false
  let replay: AgentMessage[] | undefined
  return {
    signature: input.signature,
    reusable: () => !fellBack,
    transform: async (
      messages: AgentMessage[],
      accepts?: (messages: readonly AgentMessage[]) => boolean,
    ) => {
      if (
        !fellBack &&
        contextSizeTokens(messages, input.overheadTokens) <=
          compactionBudget(input.settings).threshold
      )
        return messages
      fellBack = true
      replay ??= input.replay()
      return input.compact([...replay, ...messages.slice(input.nativePrefixLength)], accepts)
    },
  }
}
