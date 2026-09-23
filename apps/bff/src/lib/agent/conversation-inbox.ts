import type {
  AgentQueuedMessageView,
  AgentQueueInterjectResult,
  AgentQueueWithdrawResult,
  AgentReturnedQueuedMessage,
} from '@image-playground/shared'
import { bffDrain } from '../drain'
import { notifyConversation } from './events'
import type { EnqueueUserMessage, InboxEntry } from './inbox'
import {
  agentInboxEntry,
  claimAgentMessageForInterjection,
  enqueueAgentUserMessage,
  hasPendingAgentWake,
  pendingAgentMessage,
  requeueAgentMessage,
  returnAgentMessages,
  returnedAgentMessages,
  settleAgentInterjection,
  withdrawAgentMessage,
} from './inbox'
import type { RunningTurn } from './runningTurns'
import { runningTurn } from './runningTurns'
import type { TurnNotStarted } from './start-turn'
import { drainConversationInbox, kickConversationInbox } from './start-turn'

/**
 * 排队消息的规则。`inbox.ts` 是收件箱里的一行行记录，这里是围着它的那几件事：发送、撤回、
 * 升级为插话、停止退回。每一件都要按固定的先后动几样东西——收件箱那一行、在跑的那一轮、
 * 连着的设备——顺序错了就会两头落空或者处理两次，所以顺序只写在这里，路由只做翻译。
 */

/**
 * 停止与「排队消息升级为插话」的交接。升级在插话进这一轮前的一刻才从收件箱取走那一条；停止
 * 要先把排队消息退回再中止。两边都在本进程里（停止与升级都转到握着这一轮的实例），所以在这里
 * 排个先后：停止一开始，新的取走一律不成立；已经在路上的取走等它落定，落定了的那条插话就是在
 * 停止之前进的这一轮，没落定的仍排着、由停止退回。
 */
interface TurnClaims {
  stopping: boolean
  readonly inFlight: Set<Promise<boolean>>
}

const claims = new Map<string, TurnClaims>()

function claimsOf(turnId: string): TurnClaims {
  let entry = claims.get(turnId)
  if (!entry) {
    entry = { stopping: false, inFlight: new Set() }
    claims.set(turnId, entry)
  }
  return entry
}

/** 替这一轮从收件箱取走一条排队消息；这一轮已经在停止就不取。 */
async function claimForTurn(turnId: string, claim: () => Promise<boolean>): Promise<boolean> {
  const entry = claimsOf(turnId)
  if (entry.stopping) return false
  const pending = claim()
  entry.inFlight.add(pending)
  try {
    return await pending
  } finally {
    entry.inFlight.delete(pending)
    if (!entry.stopping && entry.inFlight.size === 0) claims.delete(turnId)
  }
}

/** 这一轮是否已经有人按了停止。 */
function turnStopping(turnId: string): boolean {
  return claims.get(turnId)?.stopping ?? false
}

/** 开始停止这一轮：之后的取走都不成立，已经在路上的等它落定。 */
async function beginTurnStop(turn: RunningTurn): Promise<void> {
  const entry = claimsOf(turn.turnId)
  if (!entry.stopping) {
    entry.stopping = true
    const forget = () => {
      if (claims.get(turn.turnId) === entry) claims.delete(turn.turnId)
    }
    if (turn.completed) void turn.completed.then(forget, forget)
    else setTimeout(forget, 60_000).unref?.()
  }
  await Promise.allSettled([...entry.inFlight])
}

/** 发送之后这一条的去向。 */
export type InboxSendResult =
  /** 队满了，这一条没进去。 */
  | { readonly kind: 'full' }
  /** 当场开了一轮，把它的事件流交给发送方。 */
  | { readonly kind: 'started'; readonly turn: RunningTurn }
  /** 排着（或已经被取走、被撤回）：`entry` 是它此刻的状态，`runningTurnId` 是正在跑的那一轮。 */
  | { readonly kind: 'queued'; readonly entry: InboxEntry; readonly runningTurnId?: string }
  /** 轮到它却开不了轮（余额不足等）：它已经撤出队列，原因原样交回，草稿留在输入框。 */
  | { readonly kind: 'not_started'; readonly failure: TurnNotStarted }

/** 这一条此刻的状态；记录没了（会话刚被删）就按已撤回报。 */
async function settledEntry(conversationId: string, entry: InboxEntry): Promise<InboxEntry> {
  return (
    (await agentInboxEntry(conversationId, entry.view.id)) ?? {
      ...entry,
      state: 'cancelled' as const,
    }
  )
}

/** 排队列表里多了一条：连着的设备据此把它显示出来，不必再问一次。 */
function notifyQueued(conversationId: string, queued: AgentQueuedMessageView): void {
  notifyConversation(conversationId, { type: 'messageQueued', message: queued })
}

/**
 * 别处排进收件箱的那句话得有人取：会话忙着就通知那一轮（它收尾时会来取），闲着就当场开轮。
 * 用户在保存卡片上按下保存时落的那一句走它——那句话与卡片改写是同一件事，在 `saves.ts` 里
 * 一并排进了收件箱。
 */
export function announceQueuedMessage(
  conversationId: string,
  queued: AgentQueuedMessageView,
): void {
  if (runningTurn(conversationId)) notifyQueued(conversationId, queued)
  else kickConversationInbox(conversationId)
}

/**
 * 快照读到这个会话没人在跑：队里还有人等着（排着的消息或唤醒）就接着开轮。收尾的那个实例
 * 下线了或半路没了时由它兜住，不必等定时巡查；本实例正在下线就不接，留给新版本（见
 * `inbox-pickup`）。轮到时没能开轮的那几条不算在等：它们等的是用户撤掉，不是有人来取。
 */
export async function pickUpIdleConversation(
  conversationId: string,
  queue: readonly AgentQueuedMessageView[],
): Promise<void> {
  if (bffDrain.status().draining) return
  const waiting = queue.some((one) => !one.failure) || (await hasPendingAgentWake(conversationId))
  if (waiting) kickConversationInbox(conversationId)
}

/**
 * 收一条用户消息：先进收件箱，再决定是通知还是取件——忙时它排在后面、由那一轮收尾时取走，
 * 闲时当场开轮就是一次普通的发送。
 */
export async function sendToConversationInbox(
  conversationId: string,
  message: EnqueueUserMessage,
): Promise<InboxSendResult> {
  const enqueued = await enqueueAgentUserMessage(conversationId, message)
  if (enqueued.kind === 'full') return { kind: 'full' }
  const { entry } = enqueued
  // 网络重发的同一条：交回它此刻的状态，不排第二次、不开第二轮，也不再通知一遍。
  if (enqueued.kind === 'duplicate')
    return { kind: 'queued', entry, ...runningTurnIdOf(conversationId) }
  const local = runningTurn(conversationId)
  if (local) {
    notifyQueued(conversationId, entry.view)
    return { kind: 'queued', entry, runningTurnId: local.turnId }
  }
  const drained = await drainConversationInbox(conversationId, { quietFor: entry.view.id })
  if (drained.kind === 'started' && drained.queueId === entry.view.id)
    return { kind: 'started', turn: drained.turn }
  if (drained.kind !== 'not_started' || drained.queueId !== entry.view.id) {
    // 这一条没有当场开轮：前面还排着别的、会话被别处占着、被别的设备撤回了，或者被并发的
    // 收尾取走了。重读它此刻的状态再回报。
    const runningTurnId =
      drained.kind === 'started'
        ? drained.turn.turnId
        : drained.kind === 'already_running'
          ? drained.turnId
          : undefined
    const settled = await settledEntry(conversationId, entry)
    if (settled.state === 'pending') notifyQueued(conversationId, settled.view)
    return { kind: 'queued', entry: settled, ...(runningTurnId ? { runningTurnId } : {}) }
  }
  // 开不了轮：这一条不留在队里，照旧把原因交回去。
  await withdrawAgentMessage(conversationId, entry.view.id)
  return { kind: 'not_started', failure: drained.failure }
}

function runningTurnIdOf(conversationId: string): { runningTurnId?: string } {
  const local = runningTurn(conversationId)
  return local ? { runningTurnId: local.turnId } : {}
}

/**
 * 撤回一条排队消息。撤回与取走争同一行，只有一个成立；只有这一次撤下的才通知别的设备，
 * 重发的撤回拿到同一个结局、不再通知一遍。
 */
export async function withdrawFromConversationInbox(
  conversationId: string,
  queueId: string,
): Promise<AgentQueueWithdrawResult> {
  const { result, fresh } = await withdrawAgentMessage(conversationId, queueId)
  if (fresh) notifyConversation(conversationId, { type: 'queuedMessageWithdrawn', queueId })
  return result
}

/** 升级为插话之后这一条的去向；`turnId` 是它进的那一轮。 */
export interface InboxPromoteResult {
  readonly result: AgentQueueInterjectResult
  readonly turnId?: string
}

/** 它此刻的状态就是升级的结局：被停止退回、被撤回、被起轮取走，或者仍排着。 */
async function promoteOutcome(
  conversationId: string,
  queueId: string,
): Promise<InboxPromoteResult> {
  const entry = await agentInboxEntry(conversationId, queueId)
  if (!entry) return { result: 'not_found' }
  if (entry.state === 'pending') return { result: 'not_running' }
  return { result: entry.state === 'consumed' ? 'already_consumed' : 'cancelled' }
}

/**
 * 把一条排队消息升级为插话：进正在跑的那一轮，在它下一个动作边界生效，不再等这一轮结束。
 *
 * 参考图校验与归档要花几秒，这期间它仍然排着——停止、撤回、起轮都照常拿得到它，进程半路没了
 * 它也还在队里；到真正进那一轮的前一刻才取走。取走与停止在这里排先后：停止一开始，取走就不
 * 成立；取走已经在路上的，停止等它落定。
 */
export async function promoteToInterjection(
  conversationId: string,
  queueId: string,
): Promise<InboxPromoteResult> {
  const active = runningTurn(conversationId)
  if (!active) return promoteOutcome(conversationId, queueId)
  const pending = await pendingAgentMessage(conversationId, queueId)
  if (pending.kind === 'unavailable') return { result: pending.result }
  const { message } = pending
  let claimed = false
  const claim = () =>
    claimForTurn(active.turnId, async () => {
      claimed = await claimAgentMessageForInterjection(conversationId, message.id, active.turnId)
      return claimed
    })
  // 取走之后才插不进去的那种（本轮刚好收尾）：取走之后的每一步都已同步写进这一轮，抛错也是
  // 插进去之后的事，所以只有明确返回 null 才放回。
  const messageId = await active.interject(message.text, message.references, {
    messageId: message.id,
    claim,
  })
  if (!messageId) {
    // 没取到：它此刻的状态就是结局（被停止退回、被撤回、被起轮取走，或者仍排着）。
    if (!claimed) return promoteOutcome(conversationId, message.id)
    // 取走了却没插进去：放回待处理，照旧排在原来的位置。
    await requeueAgentMessage(conversationId, message.id, active.turnId)
    // 放回去的时候那一轮可能已经放手了：没人会再来取，这里接着开轮。按了停止的不开——
    // 停止等着这一步落定，随后把它和别的排队消息一起退回。
    if (!turnStopping(active.turnId) && !runningTurn(conversationId))
      kickConversationInbox(conversationId)
    return { result: 'not_running' }
  }
  await settleAgentInterjection(conversationId, message.id)
  notifyConversation(conversationId, {
    type: 'queuedMessageInterjected',
    queueId: message.id,
    turnId: active.turnId,
  })
  return { result: 'interjected', turnId: active.turnId }
}

/** 停止之后交还给客户端的那几条排队消息；没有这一轮可停时是 `no_such_turn`。 */
export type InboxStopResult =
  | { readonly kind: 'stopped'; readonly returned: AgentReturnedQueuedMessage[] }
  | { readonly kind: 'no_such_turn' }

/**
 * 停止这一轮：先让在路上的插话升级落定，再退回排队消息，最后中止。这一轮收尾时队里已经空了，
 * 不会接着开下一轮；退回的交给客户端放回输入框，由用户决定改了再发还是删掉。
 *
 * 这一轮已经停下时不再动它：多半是上一次停止的响应丢了、客户端在重发，那次退回的照旧交还，
 * 不能因为服务端已经撤掉就两头落空。
 */
export async function stopConversationTurn(
  conversationId: string,
  turnId: string,
): Promise<InboxStopResult> {
  const active = runningTurn(conversationId)
  if (active?.turnId !== turnId) {
    const returned = await returnedAgentMessages(conversationId, turnId)
    return returned.length === 0 ? { kind: 'no_such_turn' } : { kind: 'stopped', returned }
  }
  await beginTurnStop(active)
  const { returned, fresh } = await returnAgentMessages(conversationId, turnId)
  for (const queueId of fresh)
    notifyConversation(conversationId, { type: 'queuedMessageWithdrawn', queueId })
  active.abort()
  return { kind: 'stopped', returned }
}
