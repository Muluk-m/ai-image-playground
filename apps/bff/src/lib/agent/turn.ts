import { Agent } from '@earendil-works/pi-agent-core'
import type {
  AgentContentBlock,
  AgentMessageView,
  AgentMode,
  AgentStoredReference,
  AgentTurnCost,
  AgentTurnErrorCode,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnUsage,
} from '@image-playground/shared'
import { db } from '../../db/client'
import { bffDrain } from '../drain'
import { log } from '../logger'
import type { BffTransaction, TaskOutcome } from '../private-overlay'
import { createAutoSubmitBudget } from './auto-submit'
import { AGENT_CLARIFICATION_TOOL, clarificationFromResult } from './clarification'
import { compactionSettings } from './compaction-settings'
import { createCompactionTransform } from './compaction-transform'
import {
  type AgentHistoryWindow,
  appendAgentMessage,
  recordAgentToolCall,
  touchAgentConversation,
} from './conversations'
import { openTurnEventLog } from './events'
import { ConversationExecutionLost } from './execution'
import {
  type AgentImageReference,
  archiveAgentReferences,
  createAgentImageSource,
  removeAgentTurnReferences,
  requireAgentImages,
} from './images'
import { createMaskedEditPlan, type MaskedPlanCarry } from './masked-plan'
import { agentModel, agentStreamFn } from './model'
import {
  AgentContextOverflow,
  assertRequestWithinBudget,
  requestOverheadTokens,
} from './request-budget'
import { type RunningTurn, registerRunningTurn } from './runningTurns'
import { type AgentTurnAudience, loadAgentTurnAudience } from './skills'
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
import { createTurnAuthorization } from './turn-authorization'
import {
  clarificationChainStart,
  expandSkillInvocation,
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
  readonly assertExecution?: () => Promise<void>
  readonly withExecution?: <T>(callback: (tx: BffTransaction) => Promise<T>) => Promise<T>
  readonly conversationId: string
  readonly turnId: string
  readonly userMessageId: string
  /** 这一轮取走的排队消息；缺席即这一句是当场发来的，没排过队。 */
  readonly queueId?: string
  /**
   * 起轮时读到的那一段历史：锚点之后的消息、已折进摘要的条数、压缩记录三件一套
   * （见 `listAgentHistoryWindow`）。整份传下去，不在沿途拆开重组。
   */
  readonly history: AgentHistoryWindow
  readonly text: string
  /** 输入框里附上的参考图，序号就是提示词里的 `[image N]`。 */
  readonly references: readonly AgentTurnReference[]
  /** 选区继承起点；普通新请求由澄清链推导，恢复轮可指向被打断轮。 */
  readonly selectionHistoryStart?: number
  /** 这一轮要创作什么；缺席即图片。工具清单与技能清单都按它过滤。 */
  readonly mode: AgentMode
  /** 工具提交的图片任务归到这个身份下，计费与配额因此与用户自己提交的一致。 */
  readonly userId: string | null
  readonly deviceId: string
  /**
   * 这一轮谁在看：他的模板进技能清单，他看得见的工具才装配。起轮方已经取过一次就传进来，
   * 缺席时这里自己取——两条路给出的清单必须是同一份，预扣才与真发的对得上。
   */
  readonly audience?: AgentTurnAudience
  /** 用户在输入框的参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
  /**
   * 唤醒轮：`text` 是给模型的系统说明，不是用户的话，也不落库。授权原文与改图计划接着提交那一批
   * 的那一轮（`plan`，它记着当时的授权原文）；没有记下计划时退回 `authorizationPrompt`（提交那一轮
   * 用户的原话）。要复核的产物作为视觉证据附上。
   */
  readonly wake?: {
    readonly authorizationPrompt: string
    readonly plan?: MaskedPlanCarry
    readonly reviewImageIds: readonly string[]
    /** 中断续跑才有：被打断那一轮已经提交的任务，同样的调用再来一次时交回它们（见 `interrupted.ts`）。 */
    readonly replay?: AgentSubmissionReplay
  }
  /**
   * 并进这一轮的唤醒：用户说话时恰好有后台任务的结果等着智能体看。`text` 跟在用户原话后面
   * 送给模型，不落库、不算授权原文；要复核的产物与唤醒轮一样作为视觉证据附上。
   */
  readonly wakeNote?: {
    readonly text: string
    readonly reviewImageIds: readonly string[]
  }
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

const settlementDelay = (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000)

async function settleDurably(
  settle: NonNullable<StartAgentTurnInput['settle']>,
  settlement: AgentTurnSettlement,
  assertExecution?: () => Promise<void>,
): Promise<AgentTurnCost> {
  for (let attempt = 0; ; attempt++) {
    try {
      await assertExecution?.()
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
export async function startAgentTurn(input: StartAgentTurnInput): Promise<RunningTurn> {
  const { conversationId, turnId, userMessageId, settle, text: prompt } = input
  const ledger = createAgentUsageLedger({
    conversationId,
    turnId,
    userId: input.userId,
    deviceId: input.deviceId,
  })
  let modelCallId: string | null = null
  const startedAt = Date.now()
  const events = await openTurnEventLog(conversationId, turnId)
  const stream = agentStreamFn(input.params?.thinkingDepth)
  const selectionHistoryStart =
    input.selectionHistoryStart ??
    (input.wake?.plan?.protected ? 0 : clarificationChainStart(input.history.messages))
  const images = createAgentImageSource({
    references: input.references,
    history: input.history.messages,
    conversationId: input.conversationId,
    userId: input.userId,
    selectionHistoryStart,
  })
  const authorization = createTurnAuthorization({
    history: input.history.messages,
    prompt: input.wake?.authorizationPrompt ?? prompt,
    references: images.references,
    attached: input.references.length > 0,
    ...(input.wake?.plan ? { carried: input.wake.plan.authorization } : {}),
  })
  let clarified = false
  /** 这一轮已经拟出待确认的稿：接下来该说话的是用户，再问一次模型只是白花钱。 */
  let drafted = false
  const maskedEditPlan = createMaskedEditPlan(
    () => authorization.current().instructions,
    images.identify,
    images.masked,
    input.wake?.plan,
  )
  const toolFailures = createToolFailureLog()
  // 起轮方多半已经取过一次（预扣要按同一份清单算），没取过的自己取。
  const audience = input.audience ?? (await loadAgentTurnAudience(input.userId))
  const initialState = turnInitialState(
    input.history.messages,
    input.mode,
    input.params?.autoSubmit === true,
    selectionHistoryStart,
    audience,
  )
  const turnTools = agentTurnTools(
    {
      mode: input.mode,
      conversationId: input.conversationId,
      turnId: input.turnId,
      userId: input.userId,
      deviceId: input.deviceId,
      images,
      authorization: () => authorization.current(),
      maskedEditPlan,
      assertExecution: input.assertExecution,
      ...(input.params ? { params: input.params } : {}),
      // 出图模式：额度对象一轮一个，领完就退回拟稿（见 `auto-submit.ts`）。
      ...(input.params?.autoSubmit ? { autoSubmit: createAutoSubmitBudget() } : {}),
      ...(input.wake?.replay ? { replay: input.wake.replay } : {}),
    },
    toolFailures,
  )
  const budget = compactionSettings()
  // 系统说明与工具清单这一轮里逐字不变，算一次就够；塑形按它让预算，硬闸按真发出去的那一份判。
  const overheadTokens = requestOverheadTokens({
    systemPrompt: initialState.systemPrompt,
    tools: turnTools,
  })
  // 这两个在 `new Agent` 之前声明：streamFn 的闭包要写它们，读的人也该先看见它们。
  let error: AgentTurnErrorCode | undefined
  let aborted = false
  const agent = new Agent({
    initialState: {
      ...initialState,
      model: agentModel(input.params?.thinkingDepth),
      thinkingLevel: agentThinking(input.params?.thinkingDepth).effort,
      tools: turnTools,
    },
    streamFn: async (model, context, options) => {
      await input.assertExecution?.()
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
            conversationId: input.conversationId,
            turnId: input.turnId,
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
        }
        throw thrown
      }
      modelCallId = await ledger.begin('conversation', model.id, context)
      return stream(model, context, options)
    },
    // 逐个跑：每次调用都是一条计费任务，并发起来事件次序也对不上产出落画布的顺序。
    toolExecution: 'sequential',
    // 澄清、拟稿或用户中止后，不再回上游追加一次模型调用。
    shouldStopAfterTurn: () => clarified || drafted || aborted,
    transformContext: createCompactionTransform({
      conversationId: input.conversationId,
      turnId: input.turnId,
      historyIds: input.history.messages.map((message) => message.id),
      userMessageId: input.userMessageId,
      compaction: input.history.compaction,
      foldedBefore: input.history.coveredCount,
      overheadTokens,
      onSummaryAttempt: ledger.recordSummary,
    }),
  })

  /** 终帧发过没有。收尾半路抛错时据此补一个，续播的消费者不能一直等下去。 */
  let ended = false
  let storedAny = false
  let open: OpenAssistantMessage | null = null
  let acceptingInterjections = true
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
    writes = writes.then(() => (input.withExecution ? input.withExecution(append) : append(db)))
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
      write(async (executor) => {
        await appendAgentMessage(executor, {
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
    write(async (executor) => {
      await appendAgentMessage(executor, {
        id: messageId,
        conversationId,
        turnId,
        role: 'assistant',
        content: [block],
      })
      storedAny = true
    })

  const store = (message: OpenAssistantMessage) =>
    write(async (executor) => {
      if (!message.text) return
      await appendAgentMessage(executor, {
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
      if (event.message.stopReason === 'error' && !aborted) error ??= 'agent_upstream_error'
      else await closeOpen()
      open = null
      flushQueued()
    }
    if (event.type === 'tool_execution_start' && isAgentToolName(event.toolName)) {
      const messageId = crypto.randomUUID()
      const start = agentToolStart(
        input.mode,
        event.toolName,
        event.toolCallId,
        event.args,
        images,
        input.params,
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
      const failure = event.isError ? toolFailures.take(event.toolCallId, aborted) : null
      const { block, abortsTurn } = agentToolEnd(pending.start, event.result, failure)
      const { type: _stored, ...fields } = block
      events.emit({ type: 'toolEnd', messageId: pending.messageId, ...fields })
      await storeBlock(block, pending.messageId)
      if (block.status === 'awaiting_confirmation') drafted = true
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
    ...(input.wake ? { wake: true as const } : {}),
  })
  if (input.queueId) events.emit({ type: 'queuedMessageConsumed', queueId: input.queueId, turnId })

  let resolveCompleted!: () => void
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const turn: RunningTurn = {
    completed,
    conversationId,
    turnId,
    mode: input.mode,
    read: (afterSeq) => events.read(afterSeq),
    async interject(text, references = [], options = {}) {
      if (!acceptingInterjections || aborted) return null
      const evidence = await turnVisualEvidence(references)
      if (!acceptingInterjections || aborted) return null
      await input.assertExecution?.()
      const messageId = options.messageId ?? crypto.randomUUID()
      const archiveId = `${turnId}/interjections/${messageId}`
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
      const active = references.length ? references : images.references
      const steered = turnModelPrompt(
        turnPromptText(
          expandSkillInvocation(text, input.mode, audience),
          active,
          references.length > 0,
        ),
        evidence,
      )
      const pending = steeringReferences.get(steered.text) ?? []
      // 授权原文仍是用户打的那句：`/skill-name` 展开出来的是给模型看的指引，不是他的许可。
      pending.push({ references, text, active })
      steeringReferences.set(steered.text, pending)
      queued.push({ id: messageId, text, references: stored })
      if (!open) flushQueued()
      events.emit({ type: 'interjection', messageId, text })
      await input.assertExecution?.()
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

  // 视觉证据只带本轮真的附上的那几张：沿用下来的引用只上清单文字，模型要看内容自己调 viewImage。
  void requireAgentImages(
    images,
    input.references.map((reference) => reference.imageId),
  )
    .then(async (references) => {
      if (aborted) return
      // 唤醒轮要复核的产物跟在参考图后面；取不到的那张（任务行已清掉）就不附，模型照结果文字说。
      const reviewIds = [
        ...(input.wake?.reviewImageIds ?? []),
        ...(input.wakeNote?.reviewImageIds ?? []),
      ]
      const reviewed = (await Promise.all(reviewIds.map((id) => images.resolve(id)))).filter(
        (image) => image !== null,
      )
      const evidence = await turnVisualEvidence([...references, ...reviewed])
      if (aborted) return
      // `/skill-name` 只改送给模型的这一份；落库与回显的用户消息仍是他打的原话。
      const asked = turnPromptText(
        expandSkillInvocation(prompt, input.mode, audience),
        images.references,
        input.references.length > 0,
      )
      const sent = turnModelPrompt(
        input.wakeNote ? `${asked}\n\n${input.wakeNote.text}` : asked,
        evidence,
      )
      await input.assertExecution?.()
      return agent.prompt(sent.text, sent.content)
    })
    .catch((thrown) => {
      if (aborted || error) return
      log.warn({ event: 'agent.turn_failed', err: thrown }, 'agent turn failed')
      error = 'agent_run_failed'
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
      if (error) open = null
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
          input.assertExecution,
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
      ended = true
      await touchAgentConversation(conversationId)
      await events.flush()
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
