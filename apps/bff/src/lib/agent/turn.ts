import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentContentBlock,
  AgentMessageView,
  AgentMode,
  AgentStoredReference,
  AgentTurnCost,
  AgentTurnErrorCode,
  AgentTurnFailure,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnUsage,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { bffDrain } from '../drain'
import { log } from '../logger'
import type { BffTransaction, TaskOutcome } from '../private-overlay'
import { createAutoSubmitBudget } from './auto-submit'
import { AGENT_CLARIFICATION_TOOL, clarificationFromResult } from './clarification'
import { compactionSettings } from './compaction-settings'
import { createCompactionTransform } from './compaction-transform'
import {
  type AgentOwner,
  appendAgentMessage,
  recordAgentToolCall,
  touchAgentConversation,
} from './conversations'
import { openTurnEventLog } from './events'
import { ConversationExecutionLost, type TurnExecution } from './execution'
import {
  type AgentImageReference,
  archiveAgentReferences,
  claimConversationMedia,
  createAgentImageSource,
  type ResolvedAgentImage,
  removeAgentTurnReferences,
  requireAgentImages,
  resolveTurnReferences,
  shownImageRequests,
} from './images'
import { createMaskedEditPlan, type MaskedPlanCarry } from './masked-plan'
import { agentModel, agentStreamFn } from './model'
import { modelHistoryTransform, saveModelHistoryAfterTurn } from './model-history'
import { AgentRequestBudgetError } from './outbound-budget'
import {
  AgentContextOverflow,
  assertRequestWithinBudget,
  requestOverheadTokens,
} from './request-budget'
import { type RunningTurn, registerRunningTurn } from './runningTurns'
import { InvalidSelectionError } from './selection-preview'
import type { AgentTurnAudience } from './skills'
import { agentThinking } from './thinking'
import {
  type AgentSubmissionReplay,
  type AgentToolStart,
  agentToolEnd,
  agentToolStage,
  agentToolStart,
  agentTurnTools,
  createToolFailureLog,
  isAgentToolName,
} from './tools'
import { AgentToolError } from './tools/errors'
import { createTurnAuthorization } from './turn-authorization'
import { agentTurnFailure } from './turn-failure'
import {
  type AgentTurnInput,
  expandSkillInvocation,
  turnInitialStateOf,
  turnModelPrompt,
  turnPromptBody,
  turnPromptText,
  turnVisualEvidence,
} from './turn-input'
import { recordAgentTurnSummary } from './turn-summary'
import { createAgentUsageLedger } from './usage-ledger'
import { assertVisualBytes } from './visual-resources'
import { createVisualWorkset } from './visual-workset'

export interface AgentTurnSettlement {
  readonly outcome: TaskOutcome
  readonly usage: AgentTurnUsage | null
  readonly upstreamInvocationCount: number
}

/**
 * 准备好的一轮：起轮准备（`turn-preparation.ts`）交出来的全部东西，`startAgentTurn` 只认它。
 * 用户消息、唤醒与中断续跑三种来源的差别都已经在准备那一步折平。
 */
export interface PreparedAgentTurn {
  /** 这一轮对会话的执行权：写库之前确认，落库在它的事务里。 */
  readonly execution: TurnExecution
  readonly conversationId: string
  /** 起轮准备已经确权的会话归属；轮后重读历史照它读。 */
  readonly owner: AgentOwner
  readonly turnId: string
  readonly userMessageId: string
  readonly storedUserMessage?: AgentMessageView
  /** 这一轮取走的排队消息；缺席即这一句是当场发来的，没排过队。 */
  readonly queueId?: string
  /** 送给模型的那一份输入；起轮前的预扣就是照它估的（见 `turn-input.ts`）。 */
  readonly input: AgentTurnInput
  /** 工具提交的图片任务归到这个身份下，计费与配额因此与用户自己提交的一致。 */
  readonly userId: string | null
  readonly deviceId: string
  /** 用户在输入框的参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
  /** 发话时浏览器里的画布。 */
  readonly canvas?: import('@image-playground/shared').AgentCanvasSnapshot
  /**
   * 唤醒轮与中断续跑：`input.text` 是给模型的系统说明，不是用户的话，也不落库。授权原文与改图
   * 计划接着提交那一批的那一轮（`plan`，它记着当时的授权原文）；没有记下计划时退回
   * `authorizationPrompt`（提交那一轮用户的原话）。要复核的产物在 `input.reviewImageIds`。
   */
  readonly wake?: {
    readonly authorizationPrompt: string
    readonly plan?: MaskedPlanCarry
    /** 中断续跑才有：被打断那一轮已经提交的任务，同样的调用再来一次时交回它们（见 `interrupted.ts`）。 */
    readonly replay?: AgentSubmissionReplay
  }
  /** 起轮时预扣的积分；缺席即这个部署不计费。 */
  readonly reservedCredits?: number
  /** 收尾结算，回报本轮结算后的消耗；缺席即这个部署不计费。 */
  readonly settle?: (settlement: AgentTurnSettlement) => Promise<AgentTurnCost>
}

interface OpenAssistantMessage {
  readonly id: string
  text: string
  persisted?: boolean
}

interface OpenToolCall {
  readonly messageId: string
  /** 起跑那一刻工具的自述；结果卡照它出，中途不再重算。 */
  readonly start: AgentToolStart
}

const settlementDelay = (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000)

async function settleDurably(
  settle: NonNullable<PreparedAgentTurn['settle']>,
  settlement: AgentTurnSettlement,
  assertExecution: () => Promise<void>,
): Promise<AgentTurnCost> {
  for (let attempt = 0; ; attempt++) {
    try {
      await assertExecution()
      return await settle(settlement)
    } catch (thrown) {
      if (thrown instanceof ConversationExecutionLost) throw thrown
      log.error(
        { event: 'agent.turn_settle_retry', attempt: attempt + 1, err: thrown },
        'agent turn settlement will retry',
      )
      await new Promise((resolve) => setTimeout(resolve, settlementDelay(attempt)))
    }
  }
}

/** 起一轮并立刻返回把手；`read()` 可以被断开再重开。 */
export async function startAgentTurn(prepared: PreparedAgentTurn): Promise<RunningTurn> {
  const { conversationId, turnId, userMessageId, settle, execution, input } = prepared
  const { audience, history, mode, selectionHistoryStart } = input
  const ledger = createAgentUsageLedger({
    conversationId,
    turnId,
    userId: prepared.userId,
    deviceId: prepared.deviceId,
  })
  let modelCallId: string | null = null
  const startedAt = Date.now()
  const events = await openTurnEventLog(conversationId, turnId)
  const images = createAgentImageSource({
    references: input.references,
    history: history.messages,
    conversationId,
    userId: prepared.userId,
    canvasMediaIds: prepared.canvas?.elements.flatMap((element) =>
      element.type === 'image' && element.mediaId ? [element.mediaId] : [],
    ),
    selectionHistoryStart,
  })
  const authorization = createTurnAuthorization({
    history: history.messages,
    prompt: prepared.wake?.authorizationPrompt ?? input.text,
    references: images.references,
    attached: input.references.length > 0,
    ...(prepared.wake?.plan ? { carried: prepared.wake.plan.authorization } : {}),
  })
  let clarified = false
  /** 这一轮已经拟出待确认的稿：接下来该说话的是用户，再问一次模型只是白花钱。 */
  let drafted = false
  const maskedEditPlan = createMaskedEditPlan(
    () => authorization.current().instructions,
    images.identify,
    images.masked,
    prepared.wake?.plan,
  )
  const visualWorkset = createVisualWorkset()
  const toolFailures = createToolFailureLog()
  const initialState = turnInitialStateOf(input)
  const turnTools = agentTurnTools(
    {
      mode,
      experience: audience.experience,
      conversationId,
      turnId,
      userId: prepared.userId,
      deviceId: prepared.deviceId,
      images,
      visualWorkset,
      authorization: () => authorization.current(),
      maskedEditPlan,
      assertExecution: execution.assert,
      recordWebSearch: (attempt) => ledger.recordSideCall('web_search', attempt),
      ...(prepared.params ? { params: prepared.params } : {}),
      ...(prepared.canvas ? { canvas: prepared.canvas } : {}),
      // 出图模式：额度对象一轮一个，领完就退回拟稿（见 `auto-submit.ts`）。
      ...(input.autoSubmit ? { autoSubmit: createAutoSubmitBudget() } : {}),
      ...(prepared.wake?.replay ? { replay: prepared.wake.replay } : {}),
    },
    toolFailures,
  )
  const model = agentModel(prepared.params?.thinkingDepth)
  const budget = compactionSettings(model)
  // 系统说明与工具清单这一轮里逐字不变，算一次就够；塑形按它让预算，硬闸按真发出去的那一份判。
  const overheadTokens = requestOverheadTokens({
    systemPrompt: initialState.systemPrompt,
    tools: turnTools,
  })
  const compact = createCompactionTransform({
    conversationId,
    turnId,
    historyIds: history.messages.map((message) => message.id),
    userMessageId,
    compaction: history.compaction,
    foldedBefore: history.coveredCount,
    overheadTokens,
    settings: budget,
    onSummaryAttempt: async (attempt) => {
      if (attempt.localRejection) {
        error = 'agent_request_budget_exceeded'
        failure = agentTurnFailure(error, attempt.localRejection, attempt.model)
      }
      await ledger.recordSideCall('compaction', attempt)
    },
  })
  const retained = input.modelHistory
    ? modelHistoryTransform({
        signature: input.modelHistory.signature,
        nativePrefixLength: initialState.messages.length,
        replay: () => turnInitialStateOf({ ...input, modelHistory: undefined }).messages,
        settings: budget,
        overheadTokens,
        compact,
      })
    : undefined
  // 这两个在 `new Agent` 之前声明：streamFn 的闭包要写它们，读的人也该先看见它们。
  let failure: AgentTurnFailure | undefined
  let error: AgentTurnErrorCode | undefined
  let aborted = false
  const agent = new Agent({
    initialState: {
      ...initialState,
      model,
      thinkingLevel: agentThinking(prepared.params?.thinkingDepth).effort,
      tools: turnTools,
    },
    streamFn: async (model, context, options) => {
      await execution.assert()
      // 最后一道闸：算出来就超限的请求不发。上游那边它是一个更贵、更慢、必然被拒的请求，
      // 而这一刻退回去发更完整的历史只会更超（见 `request-budget.ts`）。
      // pi 的契约是 streamFn 的失败要编进返回流里，所以它把这一抛翻成「上游出错」的终帧；
      // 原因在这里先记下，那一段才不会把「没发出去」说成「上游挂了」。
      try {
        assertRequestWithinBudget(context, budget)
      } catch (thrown) {
        if (thrown instanceof AgentContextOverflow) {
          // 两件事要分开：本轮内容太大，用户减字减图就能自救；固定开销自己就吃光了上限，
          // 那是部署把窗口配小了，用户删什么都没用，每一轮都会被拒——那条要吵醒运营。
          const misconfigured = overheadTokens >= thrown.limit
          const entry = {
            event: 'agent.context_overflow',
            conversationId,
            turnId,
            inputTokens: thrown.inputTokens,
            overheadTokens,
            limit: thrown.limit,
          }
          if (misconfigured) {
            log.error(
              entry,
              'agent system prompt and tools alone exceed the input budget; raise the configured context window',
            )
          } else {
            log.warn(entry, 'agent request exceeded the input budget and was not sent')
          }
          error ??= 'agent_context_overflow'
          failure ??= agentTurnFailure(error, thrown, model.id)
        }
        throw thrown
      }
      const callId = await ledger.begin('conversation', model.id, context)
      modelCallId = callId
      return agentStreamFn(prepared.params?.thinkingDepth, {
        onCancelledBeforeDispatch: () => ledger.cancelledBeforeDispatch(callId),
        onDispatch: async (bytes) => {
          const evidence = visualWorkset.dispatched(context.messages)
          if (evidence.length)
            log.info(
              {
                event: 'agent.visual_input',
                conversationId,
                turnId,
                blocks: evidence.length,
                evidence: evidence.map(
                  ({ source, representation, width, height, bytes, selection }) => ({
                    source,
                    representation,
                    width,
                    height,
                    bytes,
                    selection,
                  }),
                ),
              },
              'agent visual evidence dispatched',
            )
          await ledger.dispatched(callId, bytes)
        },
        onRejected: async (rejection) => {
          error = 'agent_request_budget_exceeded'
          failure = agentTurnFailure(error, rejection, model.id)
          await ledger.rejected(callId, rejection)
        },
      })(model, context, options)
    },
    // 一次工具边界把已排队的插话按顺序交给模型，避免每句再触发一次模型请求。
    steeringMode: 'all',
    // 逐个跑：每次调用都是一条计费任务，并发起来事件次序也对不上产出落画布的顺序。
    toolExecution: 'sequential',
    // 澄清、拟稿或用户中止后，不再回上游追加一次模型调用。
    shouldStopAfterTurn: () => clarified || drafted || aborted || !!error,
    transformContext: (messages) =>
      visualWorkset.transform(messages, retained?.transform ?? compact),
  })

  /** 终帧发过没有。收尾半路抛错时据此补一个，续播的消费者不能一直等下去。 */
  let ended = false
  let storedAny = false
  let open: OpenAssistantMessage | null = null
  let acceptingInterjections = true
  // 记录每条消息刚写下的原貌；后台任务/确认卡可能在保存快照前已被另一条链路更新。
  const storedMessages = new Map<string, AgentMessageView>()
  const remember = (message: AgentMessageView) =>
    storedMessages.set(message.id, structuredClone(message))
  if (prepared.storedUserMessage) remember(prepared.storedUserMessage)
  /** 本轮写下的消息一律经这里落库并记下原貌。 */
  const append = async (
    executor: typeof db | BffTransaction,
    id: string,
    role: 'user' | 'assistant',
    content: AgentContentBlock[],
  ) => remember(await appendAgentMessage(executor, { id, conversationId, turnId, role, content }))
  const steeringReferences = new Map<
    string,
    {
      references: readonly AgentTurnReference[]
      text: string
      /** 插话那一刻本轮认的引用；授权原文的清单按它拼。 */
      active: readonly AgentImageReference[]
    }[]
  >()
  let queued: {
    readonly id: string
    readonly text: string
    readonly references: readonly AgentStoredReference[]
  }[] = []
  // 消息表的读回顺序是插入顺序，所以落库排成一条链，不让插话抢在半截回复前面。
  let writes: Promise<void> = Promise.resolve()

  const write = (append: (executor: typeof db | BffTransaction) => Promise<void>) => {
    writes = writes.then(() => execution.write(append))
    return writes
  }

  const closeOpen = async () => {
    const current = open
    open = null
    if (current) await store(current)
  }

  const discardOpen = () => {
    const current = open
    open = null
    if (!current) return
    return write(async (executor) => {
      // An admission ahead of this write may still be committing the provisional message.
      if (!current.persisted) return
      await executor
        .delete(schema.agent_messages)
        .where(
          and(
            eq(schema.agent_messages.conversation_id, conversationId),
            eq(schema.agent_messages.id, current.id),
          ),
        )
      storedMessages.delete(current.id)
    })
  }

  const flushQueued = () => {
    const pending = queued
    queued = []
    for (const message of pending) {
      write(async (executor) => {
        await append(executor, message.id, 'user', [
          {
            type: 'text',
            text: message.text,
            ...(message.references.length ? { references: [...message.references] } : {}),
          },
        ])
      })
    }
  }

  /** 一次工具调用独占一条助手消息，两次调用的结果卡因此不会互相覆盖。 */
  const openTools = new Map<string, OpenToolCall>()

  const storeBlock = (block: AgentContentBlock, messageId: string) =>
    write(async (executor) => {
      await append(executor, messageId, 'assistant', [block])
      storedAny = true
    })

  const store = (message: OpenAssistantMessage) =>
    write(async (executor) => {
      if (!message.text) return
      if (message.persisted) {
        await executor
          .update(schema.agent_messages)
          .set({ content: [{ type: 'text', text: message.text }] })
          .where(
            and(
              eq(schema.agent_messages.conversation_id, conversationId),
              eq(schema.agent_messages.id, message.id),
            ),
          )
        const previous = storedMessages.get(message.id)
        if (previous) remember({ ...previous, content: [{ type: 'text', text: message.text }] })
      } else {
        await append(executor, message.id, 'assistant', [{ type: 'text', text: message.text }])
      }
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
        if (images.masked) maskedEditPlan.protect()
        authorization.amend(steering.text, steering.active, steering.references.length > 0)
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
      if (
        (event.message.stopReason === 'error' || event.message.stopReason === 'length') &&
        !aborted
      ) {
        error ??= 'agent_upstream_error'
        failure ??= agentTurnFailure(
          error,
          event.message.stopReason === 'length'
            ? '模型输出达到长度上限，回复未完成。请缩小请求或手动继续。'
            : event.message.errorMessage,
          model.id,
        )
        const local =
          error === 'agent_request_budget_exceeded' || error === 'agent_context_overflow'
        log.warn(
          {
            event: local ? 'agent.request_rejected' : 'agent.upstream_failed',
            conversationId,
            turnId,
            failure,
          },
          local ? 'agent request was rejected locally' : 'agent upstream call failed',
        )
        await discardOpen()
      } else await closeOpen()
      open = null
      flushQueued()
    }
    // Pi 为截断后跳过的工具也发 start/end；失败响应不能据此生成已执行的工具卡。
    if (event.type === 'tool_execution_start' && !error && isAgentToolName(event.toolName)) {
      const messageId = crypto.randomUUID()
      const start = agentToolStart(
        mode,
        event.toolName,
        event.toolCallId,
        event.args,
        images,
        prepared.params,
      )
      openTools.set(event.toolCallId, { messageId, start })
      events.emit({ type: 'toolStart', messageId, ...start, startedAt: Date.now() })
      // 起跑就落库：结果卡要等工具跑完，轮在半截丢了也还找得回当时的参数。
      const { snapshot } = start
      if (snapshot)
        await write((executor) =>
          recordAgentToolCall(executor, {
            conversationId,
            turnId,
            messageId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            snapshot,
          }),
        )
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
      const toolFailure = event.isError ? toolFailures.take(event.toolCallId, aborted) : null
      const { block, abortsTurn } = agentToolEnd(pending.start, event.result, toolFailure)
      const { type: _stored, ...fields } = block
      events.emit({ type: 'toolEnd', messageId: pending.messageId, ...fields })
      await storeBlock(block, pending.messageId)
      if (block.status === 'awaiting_confirmation') drafted = true
      if (!aborted && abortsTurn) {
        error = 'agent_tool_failed'
        failure = agentTurnFailure(error, block.message, model.id)
        agent.abort()
      }
    }
  })

  events.emit({
    type: 'turnStart',
    turnId,
    userMessageId,
    reservedCredits: prepared.reservedCredits,
    ...(prepared.wake ? { wake: true as const } : {}),
  })
  if (prepared.queueId)
    events.emit({ type: 'queuedMessageConsumed', queueId: prepared.queueId, turnId })

  let resolveCompleted!: () => void
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const turn: RunningTurn = {
    completed,
    conversationId,
    turnId,
    mode,
    read: (afterSeq) => events.read(afterSeq),
    async interject(text, references = [], options = {}) {
      if (!acceptingInterjections || aborted) return null
      const evidence = await turnVisualEvidence(
        await resolveTurnReferences(references, conversationId, prepared.userId, !options.claim),
        'interjection',
      )
      if (!acceptingInterjections || aborted) return null
      await execution.assert()
      const messageId = options.messageId ?? crypto.randomUUID()
      const archiveId = `${turnId}/interjections/${messageId}${options.claim ? '' : `/${crypto.randomUUID()}`}`
      const stored = await archiveAgentReferences(conversationId, archiveId, references)
      // 上传期间本轮可能已结束；拒收并只清理本次上传，不能误删首轮或其它插话的引用。
      const reject = async () => {
        if (stored.length) await removeAgentTurnReferences(conversationId, archiveId)
        return null
      }
      if (!acceptingInterjections || aborted) return reject()
      // 排队消息升级来的插话到这一刻才从收件箱取走：之前的几秒里它仍然排着，停止与撤回拿得到它。
      if (options.claim && !(await options.claim())) return reject()
      // 取走之后到这里之间本轮可能刚好收尾：交由调用方放回收件箱。
      if (!acceptingInterjections || aborted) return reject()
      if (!options.claim) {
        // Reserve the visible assistant message's position without ending its stream.
        const current = open
        let persistedCurrent = false
        const refused = new Error('interjection_not_accepted')
        let outcome: 'accepted' | 'duplicate' | 'rejected'
        try {
          const previousWrites = writes
          const admission = previousWrites
            .then(() =>
              execution.write(async (tx) => {
                const [existing] = await tx
                  .select({ id: schema.agent_messages.id })
                  .from(schema.agent_messages)
                  .where(
                    and(
                      eq(schema.agent_messages.conversation_id, conversationId),
                      eq(schema.agent_messages.id, messageId),
                    ),
                  )
                  .limit(1)
                if (existing) return 'duplicate' as const
                if (!acceptingInterjections || aborted) return 'rejected' as const
                if (
                  !(await claimConversationMedia(conversationId, prepared.userId, references, tx))
                )
                  throw new InvalidSelectionError('参考图或选区不可用，请重新添加')
                // Stopping while waiting for the media owner lock must roll back every claim.
                if (!acceptingInterjections || aborted) throw refused
                if (current?.text && !current.persisted) {
                  await append(tx, current.id, 'assistant', [{ type: 'text', text: current.text }])
                  persistedCurrent = true
                }
                await append(tx, messageId, 'user', [
                  { type: 'text', text, ...(stored.length ? { references: stored } : {}) },
                ])
                return 'accepted' as const
              }),
            )
            .then((result) => {
              if (persistedCurrent && current) {
                current.persisted = true
                storedAny = true
              }
              return result
            })
          // Only local admission refusals are recoverable; a failed earlier write still poisons finalization.
          writes = previousWrites.then(() =>
            admission.then(
              () => {},
              (error) => {
                if (error !== refused && !(error instanceof InvalidSelectionError)) throw error
              },
            ),
          )
          // Finalization observes the original rejection after the stream ends.
          void writes.catch(() => {})
          outcome = await admission
        } catch (error) {
          if (error === refused) return reject()
          await reject()
          throw error
        }
        if (outcome === 'rejected') return reject()
        if (outcome === 'duplicate') {
          await reject()
          return messageId
        }
      }
      const active = references.length ? references : images.references
      const steered = turnModelPrompt(
        turnPromptText(expandSkillInvocation(text, mode, audience), active, references.length > 0),
        evidence,
      )
      const pending = steeringReferences.get(steered.text) ?? []
      // 授权原文仍是用户打的那句：`/skill-name` 展开出来的是给模型看的指引，不是他的许可。
      pending.push({ references, text, active })
      steeringReferences.set(steered.text, pending)
      if (options.claim) queued.push({ id: messageId, text, references: stored })
      if (!open) flushQueued()
      events.emit({ type: 'interjection', messageId, text })
      if (options.claim) await execution.assert()
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

  // 视觉证据只带本轮真的附上的那几张：沿用下来的引用、以及张数多到只上清单的那批都不发字节，
  // 模型要看内容自己调 viewImage（规则见 `shownTurnReferences`）。
  void requireAgentImages(images, shownImageRequests(input.references))
    .then(async (references) => {
      if (aborted) return
      // Stop before reading the rest of an oversized review batch; missing evidence cannot count as reviewed.
      const reviewed: ResolvedAgentImage[] = []
      const imageBytes = (image: ResolvedAgentImage) =>
        Buffer.byteLength(image.dataUrl, 'utf8') +
        Buffer.byteLength(image.maskDataUrl ?? '', 'utf8')
      let preparedBytes = references.reduce((sum, image) => sum + imageBytes(image), 0)
      assertVisualBytes(preparedBytes)
      for (const id of input.reviewImageIds) {
        const image = await images.resolve(id)
        if (!image)
          throw new AgentToolError(
            'invalid_params',
            `复核图片 ${id} 无法读取，联合复核未完成。请重新添加有效图片或选择需要复核的范围。`,
          )
        preparedBytes += imageBytes(image)
        assertVisualBytes(preparedBytes)
        reviewed.push(image)
      }
      const reviewSet = new Set(reviewed)
      const evidence = await turnVisualEvidence([...references, ...reviewed], (image) =>
        reviewSet.has(image) ? 'result-review' : 'initial',
      )
      if (aborted) return
      // 正文与预扣估算读的是同一份轮输入（`turnPromptBody`）：`/skill-name` 的展开范围、
      // 引用清单与并进来的唤醒说明的位置，两条路因此只有一种拼法。
      const sent = turnModelPrompt(turnPromptBody(input, images.references), evidence)
      await execution.assert()
      return agent.prompt(sent.text, sent.content)
    })
    .catch((thrown) => {
      if (aborted || error) return
      log.warn({ event: 'agent.turn_failed', err: thrown }, 'agent turn failed')
      error =
        thrown instanceof AgentRequestBudgetError
          ? 'agent_request_budget_exceeded'
          : 'agent_run_failed'
      failure = agentTurnFailure(error, thrown, model.id)
    })
    .then(async () => {
      acceptingInterjections = false
      // 已经排队的落库先等定，「这一轮写出过东西没有」才算得准。
      await writes
      // 没收尾的半截回复也算产出，空轮兜底连它一起看：失败与否必须在决定落不落它之前定死，
      // 否则就成了「因为没落所以判失败、因为失败所以不落」。
      if (!error && !aborted && !storedAny && !open?.text) error = 'agent_run_failed'
      // 失败的轮不留这段没收尾的回复：面板在 turnEnd failed 时把它撤掉，历史要跟着撤，
      // 不然刷新回来它又冒出来。中止不在此列——那段话用户还看得见，照旧落库。
      if (error) await discardOpen()
      // 中止时 pi 可能走不到 message_end，已经流给用户的半截回复要自己落库。
      await closeOpen()
      flushQueued()
      await writes

      const { usage, upstreamInvocationCount } = ledger.settlement()
      const outcome: TaskOutcome = error ? 'failed' : aborted ? 'cancelled' : 'completed'
      let cost: AgentTurnCost | undefined
      if (settle) {
        cost = await settleDurably(
          settle,
          { outcome, usage, upstreamInvocationCount },
          execution.assert,
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
          ...(error ? { failure: failure ?? agentTurnFailure(error, error, model.id) } : {}),
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
        ...(error ? { error, failure: failure ?? agentTurnFailure(error, error, model.id) } : {}),
        usage,
        cost,
      })
      ended = true
      await touchAgentConversation(conversationId)
      await events.flush()
      await saveModelHistoryAfterTurn({
        outcome,
        retained,
        userMessageStored: !!prepared.storedUserMessage,
        steered: steeringReferences.size > 0,
        conversationId,
        turnId,
        owner: prepared.owner,
        mode,
        userId: prepared.userId,
        expectedHistory: [...history.messages, ...storedMessages.values()],
        previousSkills: input.skillTexts,
        messages: agent.state.messages,
        assertExecution: execution.assert,
      })
    })
    .catch(async (err) => {
      // 租约已经归了别人：这里不能再写，终帧由接手的一方补（见 `sealAbandonedTurns`）。
      if (err instanceof ConversationExecutionLost) return
      bffDrain.failed()
      log.error(
        { event: 'agent.finalization_failed', turnId, err },
        'turn could not be durably finalized; the recovery scan seals it once the lease expires',
      )
      if (ended) return
      events.emit({
        type: 'turnEnd',
        turnId,
        durationMs: Date.now() - startedAt,
        stopReason: 'failed',
        error: 'agent_run_failed',
        failure: agentTurnFailure('agent_run_failed', err, model.id),
        usage: null,
      })
      // 落不了库也无妨：连着的消费者已经收到终帧，之后的读取由补写兜底。
      await events.flush().catch(() => {})
    })
    .finally(() => {
      unregister()
      events.close()
      resolveCompleted()
    })

  return turn
}
