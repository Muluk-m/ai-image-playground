import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentContentBlock,
  AgentMessageView,
  AgentStoredReference,
  AgentTurnCost,
  AgentTurnErrorCode,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnUsage,
} from '@image-playground/shared'
import { agentClarificationSummary } from '@image-playground/shared'
import { db } from '../../db/client'
import { log } from '../logger'
import type { TaskOutcome } from '../private-overlay'
import {
  AGENT_CLARIFICATION_TOOL,
  clarificationFromResult,
  clarificationTool,
} from './clarification'
import { createCompactionTransform } from './compaction-transform'
import { appendAgentMessage, touchAgentConversation } from './conversations'
import { openTurnEventLog } from './events'
import {
  archiveAgentReferences,
  createAgentImageSource,
  referenceHasMask,
  removeAgentTurnReferences,
  requireAgentImages,
} from './images'
import { createMaskedEditPlan } from './masked-plan'
import { agentModel, agentStreamFn } from './model'
import { type RunningTurn, registerRunningTurn } from './runningTurns'
import { agentThinking } from './thinking'
import {
  type AgentToolStart,
  agentToolEnd,
  agentToolStage,
  agentToolStart,
  agentTools,
  isAgentToolName,
} from './tools'
import {
  replayTurnText,
  turnInitialState,
  turnModelPrompt,
  turnPromptText,
  turnVisualEvidence,
} from './turn-input'
import { recordAgentTurnSummary } from './turn-summary'
import { createAgentUsageLedger } from './usage-ledger'

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

interface OpenAssistantMessage {
  readonly id: string
  text: string
}

interface OpenToolCall {
  readonly messageId: string
  /** 起跑那一刻工具的自述；结果卡照它出，中途不再重算。 */
  readonly start: AgentToolStart
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
  const stream = agentStreamFn(input.params?.thinkingDepth)
  const startedAt = Date.now()
  const events = await openTurnEventLog(conversationId, turnId)
  const images = createAgentImageSource({
    references: input.references,
    history: input.history,
    userId: input.userId,
  })
  // 仅未完成的澄清链进入执行原文；已完成任务仍可供 LLM 阅读，但不是本轮授权。
  let referenceStart = input.history.length
  while (referenceStart > 0) {
    const tail = input.history.slice(0, referenceStart)
    const last = tail[tail.length - 1]!
    if (!last.content.some((block) => block.type === 'clarification')) break
    let userIndex = tail.length - 2
    while (userIndex >= 0 && tail[userIndex]!.role !== 'user') userIndex--
    if (userIndex < 0) break
    referenceStart = userIndex
  }
  let editRequest = {
    revision: 0,
    instructions: [
      ...input.history
        .slice(referenceStart)
        .flatMap((message) =>
          message.role === 'user'
            ? [replayTurnText(message)]
            : message.content.flatMap((block) =>
                block.type === 'clarification' ? [agentClarificationSummary(block)] : [],
              ),
        ),
      turnPromptText(prompt, images.references),
    ].join('\n'),
  }
  let clarified = false
  const maskedEditPlan = createMaskedEditPlan(
    () => editRequest.instructions,
    images.identify,
    images.references.some(referenceHasMask),
  )
  const agent = new Agent({
    initialState: {
      ...turnInitialState(input.history),
      model: agentModel(input.params?.thinkingDepth),
      thinkingLevel: agentThinking(input.params?.thinkingDepth).effort,
      tools: [
        ...agentTools({
          conversationId: input.conversationId,
          turnId: input.turnId,
          userId: input.userId,
          deviceId: input.deviceId,
          images,
          editRequest: () => editRequest,
          maskedEditPlan,
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
    // 澄清或用户中止后，不再回上游追加一次模型调用。
    shouldStopAfterTurn: () => clarified || aborted,
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
  const steeringReferences = new Map<
    string,
    { references: readonly AgentTurnReference[]; instructions: string }[]
  >()
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
      const steering = pending?.shift()
      if (steering) {
        maskedEditPlan.interjected()
        images.attach(steering.references)
        if (images.references.some(referenceHasMask)) maskedEditPlan.protect()
        editRequest = {
          revision: editRequest.revision + 1,
          instructions: `${editRequest.instructions}\n用户补充：${steering.instructions}`,
        }
      }
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
      // 在读取任何生成结果之前冻结整批方案；未提交过任务时允许修正参数错误。
      maskedEditPlan.capture(
        event.message.content.flatMap((block) => (block.type === 'toolCall' ? [block] : [])),
      )
      if (modelCallId) {
        await ledger.finish(modelCallId, event.message)
        modelCallId = null
      }
      // pi 不为上游失败抛异常，它把失败写进助手消息的停因。工具失败时的中止也走这里，
      // 那时 error 已经写好，别让它把更准的那个原因盖掉。
      if (event.message.stopReason === 'error' && !aborted) error ??= 'agent_upstream_error'
      else await closeOpen()
      open = null
      flushQueued()
    }
    if (event.type === 'tool_execution_start' && isAgentToolName(event.toolName)) {
      const messageId = crypto.randomUUID()
      const start = agentToolStart(event.toolName, event.toolCallId, event.args, images)
      openTools.set(event.toolCallId, { messageId, start })
      events.emit({ type: 'toolStart', messageId, ...start })
    }
    if (event.type === 'tool_execution_update') {
      const pending = openTools.get(event.toolCallId)
      const stage = agentToolStage(event.partialResult)
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
      const { block, abortsTurn } = agentToolEnd(pending.start, event.result, event.isError)
      const { type: _stored, ...fields } = block
      events.emit({ type: 'toolEnd', messageId: pending.messageId, ...fields })
      await storeBlock(block, pending.messageId)
      if (!aborted && abortsTurn) {
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
      const evidence = await turnVisualEvidence(references)
      if (!acceptingInterjections || aborted) return null
      const messageId = crypto.randomUUID()
      const archiveId = `${turnId}/interjections/${messageId}`
      const stored = await archiveAgentReferences(conversationId, archiveId, references)
      // 上传期间本轮可能已结束；拒收并只清理本次上传，不能误删首轮或其它插话的引用。
      if (!acceptingInterjections || aborted) {
        if (stored.length) await removeAgentTurnReferences(conversationId, archiveId)
        return null
      }
      const instructions = turnPromptText(text, references.length ? references : images.references)
      const steered = turnModelPrompt(instructions, evidence)
      const pending = steeringReferences.get(steered.text) ?? []
      pending.push({ references, instructions })
      steeringReferences.set(steered.text, pending)
      queued.push({ id: messageId, text, references: stored })
      if (!open) flushQueued()
      events.emit({ type: 'interjection', messageId, text })
      agent.steer({
        role: 'user',
        content: [{ type: 'text', text: steered.text }, ...steered.content],
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
    .then(async (references) => {
      if (aborted) return
      const evidence = await turnVisualEvidence(references)
      if (aborted) return
      const sent = turnModelPrompt(turnPromptText(prompt, images.references), evidence)
      return agent.prompt(sent.text, sent.content)
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
