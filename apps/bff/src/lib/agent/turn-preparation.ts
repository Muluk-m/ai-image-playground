import type { AgentMode, AgentTurnParams, AgentTurnReference } from '@image-playground/shared'
import {
  AGENT_CONVERSATION_TITLE_MAX_CHARS,
  AGENT_MAX_CONSECUTIVE_WAKES,
  agentConversationTitle,
  agentTitleLine,
} from '@image-playground/shared'
import { and, asc, eq } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { isCapabilityEnabled } from '../capabilities'
import { askChatModel } from '../chatCompletion'
import type { BffTransaction, TaskReservationFailure } from '../private-overlay'
import { loadPrivateBffOverlay } from '../private-overlay'
import { isObject } from '../type-guards'
import {
  type ChatTaskReserved,
  chatTaskPricing,
  chatTurnSettle,
  chatTurnsBilled,
  reserveChatTask,
} from './chat-task'
import {
  type AgentHistoryWindow,
  type AgentOwner,
  appendAgentMessage,
  listAgentHistoryWindow,
  listAgentTurnMessages,
  setAgentConversationTitle,
} from './conversations'
import type { TurnExecution } from './execution'
import { archiveAgentReferences, removeAgentTurnReferences } from './images'
import {
  consecutiveAgentWakes,
  consumeAgentMessage,
  pendingAgentWakes,
  type QueuedResume,
  type QueuedUserMessage,
  type QueuedWake,
} from './inbox'
import { interruptedSubmissions, resumeTurnPrompt } from './interrupted'
import {
  type AgentTurnAudience,
  ensureAgentSkills,
  loadAgentTurnAudience,
  titleSourceText,
} from './skills'
import { agentThinking } from './thinking'
import { createSubmissionReplay, resolveAgentMode } from './tools'
import type { PreparedAgentTurn } from './turn'
import { type AgentTurnInput, clarificationChainStart, estimateTurnInputTokens } from './turn-input'
import { wakePlan } from './wake'
import {
  mergedWakePrompt,
  wakeAuthorizationPrompt,
  wakeJobs,
  wakeReviewImageIds,
  wakeTurnPrompt,
  wakeTurnSetup,
} from './wake-prompt'

/**
 * 起一轮之前要做的全部事：计费门禁、取历史与受众、定价、把这一轮折成一份轮输入、按它估算并
 * 预扣、在同一个事务里取走收件箱那一条。用户消息、唤醒与中断续跑只在这里分叉，出来的是
 * 同一种 {@link PreparedAgentTurn}。
 *
 * 「预扣时的估算看到的就是实际发出的内容」由结构保证：估算与实发提示词都从
 * `prepared.input` 这一份轮输入派生（见 `turn-input.ts` 的 `turnPromptBody`），没有第二处拼法。
 *
 * 本模块静态依赖 pi 的模块图（`turn`、`turn-input`、`tools`、`skills`），所以调用方只能晚到
 * 起轮那一刻再引它：`agent:chat` 关着的部署不该在启动时付那 60-90ms。
 */

/** 这一轮从哪来。 */
export type AgentTurnSource =
  | {
      readonly kind: 'message'
      readonly message: QueuedUserMessage
      /**
       * 取走它时要不要在事件流里宣布「排队已消费」。当场开轮的那一条从没在谁的排队列表里
       * 出现过，宣布反而会让界面去撤一条不存在的排队消息。
       */
      readonly announce: boolean
    }
  | { readonly kind: 'wake'; readonly wake: QueuedWake }
  | { readonly kind: 'resume'; readonly resume: QueuedResume }

export interface PrepareTurnInput {
  readonly conversationId: string
  readonly owner: AgentOwner
  readonly turnId: string
  readonly execution: TurnExecution
  readonly source: AgentTurnSource
}

/**
 * 没能准备出一轮。`no_results` 与 `wake_limit` 只有唤醒来源会出现：怎么了结那条唤醒是这个
 * 来源自己的规矩，留给调用方（见 `start-turn.ts`）。
 */
export type TurnUnprepared =
  /** 计费部署里匿名设备开不了轮。 */
  | { readonly kind: 'authentication_required' }
  /** 起轮半路收件箱那一条被撤回或被别处取走了：什么都没落。 */
  | { readonly kind: 'withdrawn' }
  /** 唤醒点名的结果卡一张都不在：没有可看的。 */
  | { readonly kind: 'no_results' }
  /** 用户没说话时连续自动唤醒到了上限。 */
  | { readonly kind: 'wake_limit' }
  | TaskReservationFailure

export type TurnPreparation =
  | { readonly kind: 'prepared'; readonly turn: PreparedAgentTurn }
  | TurnUnprepared

/** 事务里的提前收场：取走或预扣有一步不成立，整笔回滚，收件箱里那一条原样待处理。 */
class TurnStartRollback extends Error {
  constructor(readonly result: TurnUnprepared) {
    super('turn start rolled back')
  }
}

const TITLE_TIMEOUT_MS = 2_000
/** 一句标题加 JSON 外壳绰绰有余：卡得太紧回复被截断，解析不出来这一趟就白跑。 */
const TITLE_MAX_TOKENS = 64

/**
 * 一种来源自己那一份内容：给模型的文字、参考图、创作类型与参数，以及只有它才有的东西
 * （授权原文、改图计划、提交去重、要落库的用户消息）。取完历史与受众就齐，估算之前定死。
 */
interface TurnContent {
  readonly text: string
  readonly references: readonly AgentTurnReference[]
  /** 作为视觉证据随这一轮发出的产物：唤醒要复核的那些。 */
  readonly reviewImageIds: readonly string[]
  /** 并进这一轮的唤醒：此刻排着的全部。 */
  readonly wakes?: {
    readonly ids: readonly string[]
    /**
     * 跟在用户原话后面的说明；点名的结果卡一张都不在时没有这一段，那几条唤醒照样取走。
     * 带着它预扣不下时整段丢掉，那几条唤醒也一并留在收件箱里，之后走自己的路。
     */
    readonly note?: { readonly text: string; readonly reviewImageIds: readonly string[] }
  }
  readonly mode: AgentMode
  readonly params?: AgentTurnParams
  readonly selectionHistoryStart: number
  readonly deviceId: string
  /** 唤醒与续跑没有用户消息，这个 id 不指向任何一条，只让轮头的形状与普通的轮一致。 */
  readonly userMessageId: string
  readonly queueId?: string
  readonly wake?: PreparedAgentTurn['wake']
  /** 取走与预扣之外，这一来源还要在同一事务里写的东西。 */
  readonly write?: (tx: BffTransaction) => Promise<void>
  /**
   * 事务没成的收尾：已经落进对象存储的参考图要清掉。**失败自己吞掉**——从这里抛出去会盖掉
   * 真正的失败原因（见 `removeAgentTurnReferences`）。
   */
  readonly rollback?: () => Promise<void>
  /** 预扣落定之后的后续，不挡这一轮。 */
  readonly settled?: () => void
}

/** 取件事务落定的那一份：预扣的结果（这一轮不计费时没有），与这一轮最终按哪一份轮输入走。 */
interface CommittedTurnStart {
  readonly reserved: ChatTaskReserved | undefined
  readonly input: AgentTurnInput
}

/** 一份候选的轮输入与按它算出的估算：预扣按估算，实发按输入，两边同源。 */
interface EstimatedTurnInput {
  readonly input: AgentTurnInput
  readonly estimatedInputTokens: number
}

export async function prepareAgentTurn(input: PrepareTurnInput): Promise<TurnPreparation> {
  const { conversationId, owner, turnId, execution, source } = input
  const userId = owner.kind === 'user' ? owner.userId : null
  // 计费部署里只有登录用户开得了轮：预扣挂在用户身上，匿名设备没有可扣的余额。
  if (isCapabilityEnabled('billing:credits') && owner.kind !== 'user')
    return { kind: 'authentication_required' }

  // 读历史会把窗口里结束了的后台任务结算成终局：唤醒与并进来的唤醒看到的就是它们的结果。
  // 窗口之外更老的那些不在这一趟里，由会话快照（`routes/agent.ts`）与维护任务结算。
  const history = listAgentHistoryWindow(conversationId, owner)
  // 可能抛的那两件事先落定，再让来源去备内容：用户消息那一路会把参考图写进对象存储，跟它们
  // 并排跑的话，它们抛出时那些字节还没有任何东西指着，也没有谁去清。
  const [overlay, audience] = await Promise.all([
    loadPrivateBffOverlay(),
    // 技能与这个用户自建的模板一起取：两者都要进系统提示词，预扣也按它们算。
    ensureAgentSkills().then(() => loadAgentTurnAudience(userId)),
  ])
  const content =
    source.kind === 'wake'
      ? await wakeContent(conversationId, owner, turnId, history, source.wake)
      : source.kind === 'resume'
        ? await resumeContent(conversationId, owner, turnId, history, source.resume)
        : await messageContent(conversationId, owner, turnId, history, source)
  if ('kind' in content) return content

  // 内容备齐时参考图已经落进对象存储，而估算、定价与取件事务每一步都可能抛：这一段统一收尾，
  // 不留孤儿对象。范围到事务提交为止——提交之后那条用户消息已经指着这些图了。
  let committed: CommittedTurnStart
  try {
    const window = await history
    const selectedModel = agentThinking(content.params?.thinkingDepth).model
    const pricing =
      chatTurnsBilled() && userId ? await chatTaskPricing(overlay.taskHooks, selectedModel) : null

    // 一份轮输入，两个读者：按它估算的这一笔预扣，与 `startAgentTurn` 发出去的那一份。估算在
    // 事务之外算完，取件与预扣那一笔才只有数据库往返。
    const estimated = (one: TurnContent): EstimatedTurnInput => {
      const input = turnInputOf(window, one, audience)
      return { input, estimatedInputTokens: estimateTurnInputTokens(input) }
    }
    const withNote = estimated(content)
    // 并进来的那段说明带不带得起，要到预扣那一步才知道：扣不下就退到这一份。
    const withoutNote = content.wakes?.note
      ? estimated({ ...content, wakes: { ids: content.wakes.ids } })
      : null
    const chatTask =
      pricing && userId
        ? {
            taskHooks: overlay.taskHooks,
            conversationId,
            turnId,
            userId,
            deviceId: content.deviceId,
            model: selectedModel,
            pricing,
          }
        : null

    committed = await execution.write(async (tx) => {
      // 先取走再预扣：两步同在这个事务里，任一步不成立就整笔回滚，那一条原样待处理。
      if (!(await consumeAgentMessage(tx, conversationId, sourceId(source), turnId)))
        throw new TurnStartRollback({ kind: 'withdrawn' })
      let reserved: ChatTaskReserved | undefined
      // 这一轮最终按哪一份走；退到 `withoutNote` 就是说明没进这一轮。
      let chosen = withNote
      if (chatTask) {
        let reservation = await reserveChatTask({
          tx,
          ...chatTask,
          estimatedInputTokens: chosen.estimatedInputTokens,
        })
        // 带上唤醒的说明预扣不下，就只为用户这条消息预扣：唤醒的费用不能挡住用户的话。被拒的
        // 预扣不留痕迹，同一事务里可以再来一次。
        if (reservation.kind === 'insufficient_credits' && withoutNote) {
          chosen = withoutNote
          reservation = await reserveChatTask({
            tx,
            ...chatTask,
            estimatedInputTokens: chosen.estimatedInputTokens,
          })
        }
        if (reservation.kind !== 'reserved') throw new TurnStartRollback(reservation)
        reserved = reservation
      }
      // 说明进了这一轮（或本来就没有说明）才取走那几条唤醒；被丢掉时它们留在收件箱里，
      // 之后走自己的路。
      if (content.wakes && chosen === withNote) {
        for (const id of content.wakes.ids)
          await consumeAgentMessage(tx, conversationId, id, turnId)
      }
      await content.write?.(tx)
      return { reserved, input: chosen.input }
    })
  } catch (error) {
    // 事务没提交，刚归档的参考图没有任何东西指着：清掉。
    await content.rollback?.()
    if (error instanceof TurnStartRollback) return error.result
    throw error
  }

  // 租约在这一刻可能已经归了别人：抛出去交给取件方。事务已经提交，那条用户消息正指着刚归档的
  // 参考图，所以这之后一张都不能删。
  await execution.assert()
  content.settled?.()
  return {
    kind: 'prepared',
    turn: {
      execution,
      conversationId,
      turnId,
      userMessageId: content.userMessageId,
      ...(content.queueId ? { queueId: content.queueId } : {}),
      input: committed.input,
      userId,
      deviceId: content.deviceId,
      ...(content.params ? { params: content.params } : {}),
      ...(content.wake ? { wake: content.wake } : {}),
      reservedCredits: committed.reserved?.reservedCredits,
      settle: chatTurnSettle(conversationId, turnId, committed.reserved),
    },
  }
}

/** 收件箱里要取走的那一条；用户消息那一条的 id 也就是这一轮用户消息的 id。 */
function sourceId(source: AgentTurnSource): string {
  if (source.kind === 'message') return source.message.id
  return source.kind === 'wake' ? source.wake.id : source.resume.id
}

/** 这一轮送给模型的那一份输入；估算与实发都只从它派生。 */
function turnInputOf(
  history: AgentHistoryWindow,
  content: TurnContent,
  audience: AgentTurnAudience,
): AgentTurnInput {
  const note = content.wakes?.note
  return {
    history,
    text: content.text,
    references: content.references,
    mode: content.mode,
    reviewImageIds: [...content.reviewImageIds, ...(note?.reviewImageIds ?? [])],
    ...(note ? { note: note.text } : {}),
    autoSubmit: content.params?.autoSubmit === true,
    selectionHistoryStart: content.selectionHistoryStart,
    audience,
  }
}

/**
 * 唤醒轮：后台任务结束，智能体回来看结果。没有用户消息可落，模型收到的是一段系统说明，
 * 点名这一批里的结果；要复核的产物作为视觉证据随这一轮发出去。
 */
async function wakeContent(
  conversationId: string,
  owner: AgentOwner,
  turnId: string,
  history: Promise<AgentHistoryWindow>,
  wake: QueuedWake,
): Promise<TurnContent | TurnUnprepared> {
  const [submittingTurn, plan, window] = await Promise.all([
    // 点名的结果卡与提交那一轮的用户原话都属于提交的那一轮，而它可能比历史窗口更老：定点取回来，
    // 在窗口里筛会静默筛不到，唤醒轮就成了「一个任务都找不到」。
    listAgentTurnMessages(conversationId, owner, [wake.turnId]),
    // 提交这一批时的改图计划：唤醒轮接着它走，不另起一份。
    wakePlan(wake.taskIds),
    history,
  ])
  const jobs = wakeJobs(submittingTurn, wake.taskIds)
  // 点名的结果卡一张都不在（那一轮没能落下结果卡就没了）：没有可看的。
  if (jobs.length === 0) return { kind: 'no_results' }
  // 用户没说话时连续自动唤醒到了上限：停下等用户，结果照常在画布上，他下次说话时智能体看得到。
  if ((await consecutiveAgentWakes(conversationId)) >= AGENT_MAX_CONSECUTIVE_WAKES)
    return { kind: 'wake_limit' }
  const setup = wakeTurnSetup(jobs)
  return {
    text: wakeTurnPrompt(jobs),
    references: [],
    reviewImageIds: wakeReviewImageIds(jobs),
    mode: resolveAgentMode(setup.mode),
    ...(setup.params ? { params: setup.params } : {}),
    selectionHistoryStart: plan?.protected ? 0 : clarificationChainStart(window.messages),
    deviceId: wake.deviceId || (owner.kind === 'device' ? owner.deviceId : ''),
    userMessageId: `${turnId}:wake`,
    wake: {
      authorizationPrompt: wakeAuthorizationPrompt(submittingTurn, wake.turnId),
      ...(plan ? { plan } : {}),
    },
  }
}

/**
 * 中断续跑：被打断的那一轮没说完的已经丢了，再起一轮接着做，只续这一次。与唤醒一样没有用户
 * 消息可落，模型收到的是一段系统说明；创作类型与参数沿用被打断的那一轮，已提交任务记下的改图
 * 计划也接着走——已经提交过的编辑不会再提交一次；被打断那一轮提交过的任务按调用内容去重，模型
 * 再发起同样的调用时交回原任务。被打断的是唤醒轮时，输入照那一批结果取（唤醒说明、授权原文、
 * 改图计划与要复核的产物）。
 */
async function resumeContent(
  conversationId: string,
  owner: AgentOwner,
  turnId: string,
  history: Promise<AgentHistoryWindow>,
  resume: QueuedResume,
): Promise<TurnContent> {
  const { wake } = resume
  // 结果卡与授权原话都属于被点名的那一轮：被打断的是唤醒轮就是提交那一批的那一轮，否则是被打断的
  // 那一轮。它可能比历史窗口更老，所以定点取而不是在窗口里筛。
  const authorizedTurnId = wake?.turnId ?? resume.interruptedTurnId
  const [authorizedTurn, interruptedJobs, window] = await Promise.all([
    listAgentTurnMessages(conversationId, owner, [authorizedTurnId]),
    turnJobs(conversationId, resume.interruptedTurnId),
    history,
  ])
  const [plan, submissions] = await Promise.all([
    // 改图计划接着最近的一次提交走：被打断的是唤醒轮时，先是提交那一批时的，再是它自己提交的。
    wakePlan([...(wake?.taskIds ?? []), ...interruptedJobs]),
    interruptedSubmissions(conversationId, resume.interruptedTurnId),
  ])
  // 被打断的是唤醒轮：续跑接着处理那一批结果，创作类型、参数与要复核的产物都照唤醒轮的算法取。
  const jobs = wake ? wakeJobs(authorizedTurn, wake.taskIds) : []
  const setup = wake ? wakeTurnSetup(jobs) : resume
  const interruptedStart = window.messages.findIndex(
    (message) => message.turnId === resume.interruptedTurnId,
  )
  return {
    text: resumeTurnPrompt(wake ? wakeTurnPrompt(jobs) : undefined),
    references: [],
    reviewImageIds: wakeReviewImageIds(jobs),
    mode: resolveAgentMode(setup.mode ?? 'image'),
    ...(setup.params ? { params: setup.params } : {}),
    selectionHistoryStart: plan?.protected
      ? 0
      : !wake && interruptedStart >= 0
        ? clarificationChainStart(window.messages.slice(0, interruptedStart))
        : clarificationChainStart(window.messages),
    deviceId: resume.deviceId || (owner.kind === 'device' ? owner.deviceId : ''),
    userMessageId: `${turnId}:resume`,
    wake: {
      // 授权原文仍是用户的原话：被打断那一轮的，唤醒轮则是提交那一批的那一轮的。
      authorizationPrompt: wakeAuthorizationPrompt(authorizedTurn, authorizedTurnId),
      ...(plan ? { plan } : {}),
      // 被打断那一轮已经提交的任务：同样的调用再来一次时交回它，不再提交。
      ...(submissions.length > 0 ? { replay: createSubmissionReplay(submissions) } : {}),
    },
  }
}

/** 用户消息这一轮：他的原话落库，恰好排着的唤醒并进来不再单独起轮，首轮还要落下标题。 */
async function messageContent(
  conversationId: string,
  owner: AgentOwner,
  turnId: string,
  history: Promise<AgentHistoryWindow>,
  source: Extract<AgentTurnSource, { kind: 'message' }>,
): Promise<TurnContent> {
  const { message } = source
  // 恰好排着的唤醒并进这一轮，不再单独起轮。
  const [wakes, window] = await Promise.all([pendingAgentWakes(conversationId), history])
  // 点名了哪几轮要取回来才知道，所以这一次查询只能串在后面；那几轮可能比历史窗口更老，一次全取回来。
  const jobs = wakeJobs(
    wakes.length === 0
      ? []
      : await listAgentTurnMessages(conversationId, owner, [
          ...new Set(wakes.map((pending) => pending.turnId)),
        ]),
    wakes.flatMap((wake) => wake.taskIds),
  )
  // 窗口空只说明锚点之后没有消息：压缩过的长会话窗口一样可能是空的，拿它当新会话会把用户自己
  // 改过的标题冲掉。一条都没折进摘要、窗口也空，才真是头一轮。
  const isFirstTurn = window.coveredCount === 0 && window.messages.length === 0
  const mode = resolveAgentMode(message.mode ?? 'image')
  // 首轮是 `/技能` 命令时，标题要落技能的名字；目录已由起轮前的那次加载缓存，这里只是等它。
  if (isFirstTurn) await ensureAgentSkills()
  const titleText = isFirstTurn ? titleSourceText(message.text, mode) : message.text
  const storedReferences = await archiveAgentReferences(conversationId, turnId, message.references)
  return {
    text: message.text,
    references: message.references,
    reviewImageIds: [],
    ...(wakes.length > 0
      ? {
          wakes: {
            ids: wakes.map((wake) => wake.id),
            // 点名的结果卡一张都不在时照样取走，只是不附说明。
            ...(jobs.length > 0
              ? { note: { text: mergedWakePrompt(jobs), reviewImageIds: wakeReviewImageIds(jobs) } }
              : {}),
          },
        }
      : {}),
    mode,
    ...(message.params ? { params: message.params } : {}),
    selectionHistoryStart: clarificationChainStart(window.messages),
    deviceId: message.deviceId,
    userMessageId: message.id,
    ...(source.announce ? { queueId: message.id } : {}),
    write: async (tx) => {
      if (isFirstTurn)
        await setAgentConversationTitle(
          tx,
          conversationId,
          owner,
          agentConversationTitle(titleText),
        )
      await appendAgentMessage(tx, {
        id: message.id,
        conversationId,
        turnId,
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.text,
            ...(storedReferences.length ? { references: storedReferences } : {}),
          },
        ],
      })
    },
    rollback: async () => {
      if (storedReferences.length) await removeAgentTurnReferences(conversationId, turnId)
    },
    // 自动命名不挡对话：小模型在后台改写标题，迟到或失败都只是继续用首句那个。
    settled: () => {
      if (isFirstTurn) void nameConversation(conversationId, owner, titleText)
    },
  }
}

/** 某一轮提交过的后台任务，按提交先后。 */
async function turnJobs(conversationId: string, turnId: string): Promise<string[]> {
  const rows = await db
    .select({ taskId: schema.agent_jobs.task_id })
    .from(schema.agent_jobs)
    .where(
      and(
        eq(schema.agent_jobs.conversation_id, conversationId),
        eq(schema.agent_jobs.turn_id, turnId),
      ),
    )
    .orderBy(asc(schema.agent_jobs.submitted_at))
  return rows.map((row) => row.taskId)
}

/**
 * 首轮落库的标题就是用户那句原话，这里让小模型把它概括成一个短名字。整件事在后台做：
 * 概括要过一次上游，挡在起轮前面对话就迟迟不动。
 *
 * 只在标题仍是那句原话时才改：概括迟到、期间标题已被写成别的，那一份才是更新的意思。
 */
async function nameConversation(
  conversationId: string,
  owner: AgentOwner,
  text: string,
): Promise<void> {
  try {
    const title = await askChatModel(
      {
        model: config.agent.summaryModel,
        prompt:
          '请把下面这条用户请求概括成一个简短中文项目标题。只输出 JSON：{"title":"标题"}，标题不要标点，最多12个字。\n\n用户请求：' +
          text,
        maxTokens: TITLE_MAX_TOKENS,
        timeoutMs: TITLE_TIMEOUT_MS,
      },
      (value) =>
        isObject(value) && typeof value.title === 'string'
          ? agentTitleLine(value.title, AGENT_CONVERSATION_TITLE_MAX_CHARS)
          : null,
    )
    await setAgentConversationTitle(db, conversationId, owner, title, agentConversationTitle(text))
  } catch {
    // 概括不是对话主链路：首句标题已在事务里落库，这里失败就保留它。
  }
}
