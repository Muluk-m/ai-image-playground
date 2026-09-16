import { Agent, type AgentMessage, estimateTokens } from '@earendil-works/pi-agent-core'
import type { ImageContent } from '@earendil-works/pi-ai'
import type {
  AgentContentBlock,
  AgentMessageView,
  AgentStoredReference,
  AgentToolName,
  AgentToolResultBlock,
  AgentTurnCost,
  AgentTurnErrorCode,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnUsage,
} from '@image-playground/shared'
import {
  agentClarificationSummary,
  agentTextFromBlocks,
  agentToolResultSummary,
} from '@image-playground/shared'
import { db } from '../../db/client'
import { log } from '../logger'
import type { TaskOutcome } from '../private-overlay'
import {
  AGENT_CLARIFICATION_TOOL,
  clarificationFromResult,
  clarificationTool,
} from './clarification'
import { compactionBudget } from './compaction'
import { compactionSettings } from './compaction-settings'
import { createCompactionTransform } from './compaction-transform'
import { appendAgentMessage, touchAgentConversation } from './conversations'
import { lastAgentEventSeq } from './events'
import {
  activeAgentReferences,
  archiveAgentReferences,
  createAgentImageSource,
  referenceManifest,
  removeAgentTurnReferences,
  requireAgentImages,
} from './images'
import { agentModel, agentStreamFn } from './model'
import { type RunningTurn, registerRunningTurn, turnEventLog } from './runningTurns'
import {
  type AgentToolDetails,
  agentToolAbortsTurn,
  agentToolAnchor,
  agentToolGuidance,
  agentToolOutputCount,
  agentTools,
  agentToolTitle,
  isAgentToolName,
} from './tools'
import { recordAgentTurnSummary } from './turn-summary'
import { createAgentUsageLedger } from './usage-ledger'

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function systemPrompt(): string {
  return [
    '你是创作模式画布旁的助手，帮用户把想法变成画布上的图。',
    '用中文回答，简短、具体，不要复述用户的话。',
    // 逐工具那几句跟着清单走：关掉的工具连同它的用法一起消失，否则模型会承诺它调不了的事。
    ...agentToolGuidance(),
    '工具产出会自动落到用户的画布上，不要让用户自己去保存。',
    '先结合参考图和对话上下文执行；只有缺少会阻止执行的信息时才调用澄清工具。用户回答后直接继续，不要让他重复引用已有的图。',
    '只能使用清单中的工具；交互设计图不等于可运行网页或交互代码，不要把前者说成后者。',
  ].join('\n')
}

export interface AgentTurnSettlement {
  readonly outcome: TaskOutcome
  readonly usage: AgentTurnUsage | null
  readonly upstreamInvocationCount: number
}

export interface StartAgentTurnInput {
  readonly conversationId: string
  readonly turnId: string
  readonly userMessageId: string
  readonly history: readonly AgentMessageView[]
  readonly text: string
  /** 输入框里附上的参考图，序号就是提示词里的 `[image N]`。 */
  readonly references: readonly AgentTurnReference[]
  /** 工具提交的图片任务归到这个身份下，计费与配额因此与用户自己提交的一致。 */
  readonly userId: string | null
  readonly deviceId: string
  /** 用户在输入框的参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
  /** 起轮时预扣的积分；缺席即这个部署不计费。 */
  readonly reservedCredits?: number
  /** 收尾结算，回报本轮结算后的消耗；缺席即这个部署不计费。 */
  readonly settle?: (settlement: AgentTurnSettlement) => Promise<AgentTurnCost>
}

/** 工具结果块回放成一行文字：pi 的转录里没有历史轮的工具调用，配不成对的工具结果会被上游拒。 */
function replayText(message: AgentMessageView): string {
  return message.content
    .map((block) => {
      if (block.type === 'text')
        return (
          block.text + (message.role === 'user' ? referenceManifest(block.references ?? []) : '')
        )
      if (block.type === 'clarification') return agentClarificationSummary(block)
      return agentToolResultSummary(block)
    })
    .join('\n')
    .trim()
}

/** 历史消息回放成 pi 的形状；助手消息的用量与停因是回放占位，不进任何计费。 */
function replayed(history: readonly AgentMessageView[]): AgentMessage[] {
  const model = agentModel()
  const messages: AgentMessage[] = []
  for (const message of history) {
    const text = replayText(message)
    if (!text) continue
    messages.push(
      message.role === 'user'
        ? { role: 'user', content: [{ type: 'text', text }], timestamp: message.createdAt }
        : {
            role: 'assistant',
            content: [{ type: 'text', text }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: EMPTY_USAGE,
            stopReason: 'stop',
            timestamp: message.createdAt,
          },
    )
  }
  return messages
}

/**
 * 预扣要在起轮前定额，只能估。上限取压缩阈值：压缩保证送出去的输入不超过它，
 * 不封顶就会拿整段未压缩的历史去预扣，长会话每一轮都按上限占住余额。
 */
export function estimateTurnInputTokens(
  history: readonly AgentMessageView[],
  text: string,
  references: readonly AgentTurnReference[],
): number {
  const now = Date.now()
  const active = activeAgentReferences(references, history)
  const messages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: systemPrompt() }], timestamp: now },
    ...replayed(history),
    {
      role: 'user',
      content: [
        { type: 'text', text: text + referenceManifest(active) },
        // pi 按图片块数量估 token，无需为预扣读取或复制图片字节。
        ...active.map((): ImageContent => ({ type: 'image', data: '', mimeType: 'image/png' })),
      ],
      timestamp: now,
    },
  ]
  const estimated = messages.reduce((total, message) => total + estimateTokens(message), 0)
  return Math.min(estimated, compactionBudget(compactionSettings()).threshold)
}

interface OpenAssistantMessage {
  readonly id: string
  text: string
}

interface OpenToolCall {
  readonly prompt?: string
  readonly messageId: string
  readonly toolName: AgentToolName
  readonly title: string
}

function toolDetails(result: unknown): AgentToolDetails | undefined {
  return (result as { details?: AgentToolDetails } | undefined)?.details
}

/** pi 把工具抛出的错误写成结果的文字块。 */
function toolErrorText(result: unknown): string {
  const content = (result as { content?: { type: string }[] } | undefined)?.content
  return agentTextFromBlocks(content ?? []) || '工具执行失败'
}

function toolResultBlock(
  pending: OpenToolCall,
  toolCallId: string,
  result: unknown,
  isError: boolean,
): AgentToolResultBlock {
  const head = {
    type: 'toolResult',
    toolCallId,
    toolName: pending.toolName,
    ...(pending.prompt ? { prompt: pending.prompt } : {}),
  } as const
  if (isError) {
    return { ...head, status: 'failed', title: pending.title, message: toolErrorText(result) }
  }
  const details = toolDetails(result)
  return {
    ...head,
    status: 'succeeded',
    title: pending.title,
    ...(details?.artifacts?.length ? { artifacts: details.artifacts } : {}),
    ...(details?.anchorObjectId ? { anchorObjectId: details.anchorObjectId } : {}),
  }
}

/** 起一轮并立刻返回把手；`read()` 可以被断开再重开。 */
export async function startAgentTurn(input: StartAgentTurnInput): Promise<RunningTurn> {
  const { conversationId, turnId, userMessageId, settle, text: prompt } = input
  const ledger = createAgentUsageLedger({
    conversationId,
    turnId,
    userId: input.userId,
    deviceId: input.deviceId,
  })
  let modelCallId: string | null = null
  const stream = agentStreamFn()
  const startedAt = Date.now()
  const events = turnEventLog(conversationId, turnId, await lastAgentEventSeq(conversationId))
  const images = createAgentImageSource({
    references: input.references,
    history: input.history,
    userId: input.userId,
  })
  let clarified = false
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(),
      model: agentModel(),
      messages: replayed(input.history),
      tools: [
        ...agentTools({
          conversationId: input.conversationId,
          turnId: input.turnId,
          userId: input.userId,
          deviceId: input.deviceId,
          images,
          ...(input.params ? { params: input.params } : {}),
        }),
        clarificationTool,
      ],
    },
    streamFn: async (model, context, options) => {
      modelCallId = await ledger.begin('conversation', model.id, context)
      return stream(model, context, options)
    },
    // 逐个跑：每次调用都是一条计费任务，并发起来事件次序也对不上产出落画布的顺序。
    toolExecution: 'sequential',
    // 澄清即收尾：用户的选择是下一条用户消息，所以这一轮不再回上游要下一句。
    shouldStopAfterTurn: () => clarified,
    transformContext: createCompactionTransform({
      conversationId: input.conversationId,
      turnId: input.turnId,
      historyIds: input.history.map((message) => message.id),
      userMessageId: input.userMessageId,
      onSummaryAttempt: ledger.recordSummary,
    }),
  })

  let error: AgentTurnErrorCode | undefined
  let aborted = false
  let storedAny = false
  let open: OpenAssistantMessage | null = null
  let acceptingInterjections = true
  const steeringReferences = new Map<string, (readonly AgentTurnReference[])[]>()
  let queued: {
    readonly id: string
    readonly text: string
    readonly references: readonly AgentStoredReference[]
  }[] = []
  // 消息表的读回顺序是插入顺序，所以落库排成一条链，不让插话抢在半截回复前面。
  let writes: Promise<void> = Promise.resolve()

  const write = (append: () => Promise<void>) => {
    writes = writes.then(append)
    return writes
  }

  const closeOpen = async () => {
    const current = open
    open = null
    if (current) await store(current)
  }

  const flushQueued = () => {
    const pending = queued
    queued = []
    for (const message of pending) {
      write(async () => {
        await appendAgentMessage(db, {
          id: message.id,
          conversationId,
          turnId,
          role: 'user',
          content: [
            {
              type: 'text',
              text: message.text,
              ...(message.references.length ? { references: [...message.references] } : {}),
            },
          ],
        })
      })
    }
  }

  /** 一次工具调用独占一条助手消息，两次调用的结果卡因此不会互相覆盖。 */
  const openTools = new Map<string, OpenToolCall>()

  const storeBlock = (block: AgentContentBlock, messageId: string) =>
    write(async () => {
      await appendAgentMessage(db, {
        id: messageId,
        conversationId,
        turnId,
        role: 'assistant',
        content: [block],
      })
      storedAny = true
    })

  const store = (message: OpenAssistantMessage) =>
    write(async () => {
      if (!message.text) return
      await appendAgentMessage(db, {
        id: message.id,
        conversationId,
        turnId,
        role: 'assistant',
        content: [{ type: 'text', text: message.text }],
      })
      storedAny = true
    })

  agent.subscribe(async (event) => {
    if (event.type === 'message_start' && event.message.role === 'user') {
      const content = event.message.content
      const text =
        typeof content === 'string'
          ? content
          : content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('')
      const pending = steeringReferences.get(text)
      const references = pending?.shift()
      if (references) images.attach(references)
      if (pending?.length === 0) steeringReferences.delete(text)
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      open = { id: crypto.randomUUID(), text: '' }
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      const current = open
      if (!current) return
      // 上游报错的那条助手消息一个字都没有，不为它开一个空气泡。
      if (!current.text) events.emit({ type: 'assistantStart', messageId: current.id })
      current.text += event.assistantMessageEvent.delta
      events.emit({
        type: 'textDelta',
        messageId: current.id,
        delta: event.assistantMessageEvent.delta,
      })
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (modelCallId) {
        await ledger.finish(modelCallId, event.message)
        modelCallId = null
      }
      // pi 不为上游失败抛异常，它把失败写进助手消息的停因。工具失败时的中止也走这里，
      // 那时 error 已经写好，别让它把更准的那个原因盖掉。
      if (event.message.stopReason === 'error') error ??= 'agent_upstream_error'
      else await closeOpen()
      open = null
      flushQueued()
    }
    if (event.type === 'tool_execution_start' && isAgentToolName(event.toolName)) {
      const messageId = crypto.randomUUID()
      const title = agentToolTitle(event.toolName, event.args)
      const rawPrompt = (event.args as { prompt?: unknown } | null)?.prompt
      const prompt =
        event.toolName !== 'readLibrary' && typeof rawPrompt === 'string' ? rawPrompt : undefined
      openTools.set(event.toolCallId, { messageId, toolName: event.toolName, title, prompt })
      // 画布要在工具跑完之前就占好位，所以这里把「占几个、占在哪」一并发出去：
      // 工具参数与锚点这一刻都在手上，等到 toolEnd 再说就晚了整整一次生成。
      const outputCount = agentToolOutputCount(event.toolName, event.args)
      const anchorObjectId = agentToolAnchor(event.toolName, event.args, images)
      events.emit({
        type: 'toolStart',
        messageId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        title,
        ...(prompt ? { prompt } : {}),
        ...(outputCount ? { outputCount } : {}),
        ...(anchorObjectId ? { anchorObjectId } : {}),
      })
    }
    if (event.type === 'tool_execution_update') {
      const pending = openTools.get(event.toolCallId)
      const stage = toolDetails(event.partialResult)?.stage
      if (pending && stage) {
        events.emit({
          type: 'toolProgress',
          messageId: pending.messageId,
          toolCallId: event.toolCallId,
          stage,
        })
      }
    }
    // 澄清不出工具卡，所以它不在工具注册表里，`openTools` 也没有它的登记。
    if (event.type === 'tool_execution_end' && event.toolName === AGENT_CLARIFICATION_TOOL) {
      const block = event.isError ? null : clarificationFromResult(event.result)
      if (!block) return
      const messageId = crypto.randomUUID()
      events.emit({ ...block, messageId })
      await storeBlock(block, messageId)
      clarified = true
      return
    }
    if (event.type === 'tool_execution_end') {
      const pending = openTools.get(event.toolCallId)
      if (!pending) return
      openTools.delete(event.toolCallId)
      const block = toolResultBlock(pending, event.toolCallId, event.result, event.isError)
      const { type: _stored, ...fields } = block
      events.emit({ type: 'toolEnd', messageId: pending.messageId, ...fields })
      await storeBlock(block, pending.messageId)
      if (event.isError && agentToolAbortsTurn(event.toolName)) {
        error = 'agent_tool_failed'
        agent.abort()
      }
    }
  })

  events.emit({
    type: 'turnStart',
    turnId,
    userMessageId,
    reservedCredits: input.reservedCredits,
  })

  const turn: RunningTurn = {
    conversationId,
    turnId,
    read: (afterSeq) => events.read(afterSeq),
    async interject(text, references = []) {
      if (!acceptingInterjections || aborted) return null
      const messageId = crypto.randomUUID()
      const archiveId = `${turnId}/interjections/${messageId}`
      const stored = await archiveAgentReferences(conversationId, archiveId, references)
      // 上传期间本轮可能已结束；拒收并只清理本次上传，不能误删首轮或其它插话的引用。
      if (!acceptingInterjections || aborted) {
        if (stored.length) await removeAgentTurnReferences(conversationId, archiveId)
        return null
      }
      const contentText = text + referenceManifest(references)
      const pending = steeringReferences.get(contentText) ?? []
      pending.push(references)
      steeringReferences.set(contentText, pending)
      queued.push({ id: messageId, text, references: stored })
      if (!open) flushQueued()
      events.emit({ type: 'interjection', messageId, text })
      agent.steer({
        role: 'user',
        content: [
          { type: 'text', text: contentText },
          ...references.map(
            (reference): ImageContent => ({
              type: 'image',
              mimeType: reference.dataUrl.slice(5, reference.dataUrl.indexOf(';')),
              data: reference.dataUrl.slice(reference.dataUrl.indexOf(',') + 1),
            }),
          ),
        ],
        timestamp: Date.now(),
      })
      return messageId
    },
    abort() {
      aborted = true
      agent.abort()
    },
  }
  const unregister = registerRunningTurn(turn)

  void requireAgentImages(
    images,
    images.references.map((reference) => reference.imageId),
  )
    .then((references) => {
      if (aborted) return
      const content = references.map(
        (image): ImageContent => ({
          type: 'image',
          mimeType: image.dataUrl.slice(5, image.dataUrl.indexOf(';')),
          data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1),
        }),
      )
      return agent.prompt(`${prompt}${referenceManifest(images.references)}`, content)
    })
    .catch((thrown) => {
      if (aborted || error) return
      log.warn({ event: 'agent.turn_failed', err: thrown }, 'agent turn failed')
      error = 'agent_run_failed'
    })
    .then(async () => {
      acceptingInterjections = false
      // 中止时 pi 可能走不到 message_end，已经流给用户的半截回复要自己落库。
      await closeOpen()
      flushQueued()
      await writes
      if (!error && !aborted && !storedAny) error = 'agent_run_failed'

      const { usage, upstreamInvocationCount } = ledger.settlement()
      const outcome: TaskOutcome = error ? 'failed' : aborted ? 'cancelled' : 'completed'
      let cost: AgentTurnCost | undefined
      try {
        cost = await settle?.({
          outcome,
          usage,
          upstreamInvocationCount,
        })
      } catch (thrown) {
        // 结算失败不该把已经流给用户的这一轮拖成报错；占用留给运维扫，不在这里重试。
        log.error(
          { event: 'agent.turn_settle_failed', err: thrown },
          'agent turn settlement failed',
        )
      }
      log.info(
        { event: 'agent.turn_settled', turnId, usage, error: error ?? null },
        'agent turn settled',
      )
      const durationMs = Date.now() - startedAt
      const stopReason = outcome === 'cancelled' ? 'aborted' : outcome
      try {
        // 先落持久事实再发终帧：终帧要过保留窗口就没了，页脚不能只靠它。
        await recordAgentTurnSummary({
          conversationId,
          turnId,
          durationMs,
          stopReason,
          ...(cost ? { cost } : {}),
        })
      } catch (thrown) {
        // 页脚丢一轮不该把已经流给用户的这一轮拖成报错。
        log.error(
          { event: 'agent.turn_summary_failed', turnId, err: thrown },
          'agent turn summary not stored',
        )
      }
      events.emit({
        type: 'turnEnd',
        turnId,
        durationMs,
        stopReason,
        ...(error ? { error } : {}),
        usage,
        cost,
      })
      await touchAgentConversation(conversationId)
      await events.flush()
      unregister()
      events.close()
    })

  return turn
}
