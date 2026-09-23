import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  AGENT_QUEUE_MAX_PENDING,
  type AgentQueuedMessageView,
  type AgentTurnEvent,
} from '@image-playground/shared'
import type { InboxStopResult } from '../../../lib/agent/conversation-inbox'
import type { RunningTurn } from '../../../lib/agent/runningTurns'
import { type AgentCall, completionStream, recordingAgentFetch } from '../../helpers/agentStubs'
import { silenceChatUpstream } from '../../helpers/chatStubs'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'
import { waitFor } from '../../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_conversation_inbox')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../agent-operator-config.json')

const { setAgentFetchForTesting } = await import('../../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { createAgentConversation } = await import('../../../lib/agent/conversations')
const { openTurnEventLog } = await import('../../../lib/agent/events')
const { registerRunningTurn, runningTurn } = await import('../../../lib/agent/runningTurns')
const { enqueueAgentUserMessage, queuedAgentMessages } = await import('../../../lib/agent/inbox')
const {
  announceQueuedMessage,
  pickUpIdleConversation,
  promoteToInterjection,
  sendToConversationInbox,
  stopConversationTurn,
  withdrawFromConversationInbox,
} = await import('../../../lib/agent/conversation-inbox')

await silenceChatUpstream()

const DEVICE = 'device-abcdefgh'

async function conversation(): Promise<string> {
  const created = await createAgentConversation({ kind: 'device', deviceId: DEVICE }, '')
  return created.id
}

function userMessage(text: string, clientMessageId: string = crypto.randomUUID()) {
  return { clientMessageId, text, deviceId: DEVICE, references: [] }
}

/** 忙着的会话里排进一条，返回它的 id。 */
async function queuedMessage(conversationId: string, text: string): Promise<string> {
  const sent = await sendToConversationInbox(conversationId, userMessage(text))
  if (sent.kind !== 'queued') throw new Error(`这一条没有排队：${sent.kind}`)
  return sent.entry.view.id
}

/** 等这一轮真的放手：它放手之后才轮到下一条，用例也才数得准上游被叫了几次。 */
async function settled(turn: RunningTurn): Promise<void> {
  await turn.completed
  await waitFor(() => runningTurn(turn.conversationId) === undefined, 3_000)
}

/** 直接排进收件箱一条，不经发送：保存卡片落下的那句话就是这么进来的。 */
async function noticeInInbox(
  conversationId: string,
  text: string,
): Promise<AgentQueuedMessageView> {
  const enqueued = await enqueueAgentUserMessage(conversationId, userMessage(text))
  if (enqueued.kind === 'full') throw new Error('收件箱满了')
  return enqueued.entry.view
}

/** 还排着的那几条，按处理顺序：排队列表读到的就是这一份。 */
async function queueIds(conversationId: string): Promise<string[]> {
  const queue = await queuedAgentMessages(conversationId)
  return queue.map((one) => one.id)
}

interface TurnFakeOptions {
  /** 这一轮收到插话时怎么做；默认取走成功就插进去。 */
  readonly interject?: (claim: () => Promise<boolean>, messageId: string) => Promise<string | null>
}

interface TurnFake {
  readonly turn: RunningTurn
  readonly turnId: string
  /** 这一轮的事件流里出现过什么；连着的设备看到的就是这一份。 */
  readonly events: AgentTurnEvent[]
  readonly aborted: () => number
  /** 这一轮放手：注册表里没有它了，事件日志落库之后也收了。 */
  readonly letGo: () => Promise<void>
}

/**
 * 进程里那一轮的替身。只提供收件箱要用的把手（插话与中止），事件日志是真的：会话级通知按序号
 * 进它，测试据此看见别的设备会收到什么，不必经过 SSE。
 */
async function runningTurnFake(
  conversationId: string,
  options: TurnFakeOptions = {},
): Promise<TurnFake> {
  const turnId = crypto.randomUUID()
  const eventLog = await openTurnEventLog(conversationId, turnId)
  // 发过第一条事件才算本进程开着的那一轮：通知搭它的车。
  eventLog.emit({ type: 'turnStart', turnId, userMessageId: crypto.randomUUID() })
  const events: AgentTurnEvent[] = []
  void (async () => {
    for await (const one of eventLog.read(eventLog.baseSeq)) events.push(one.event)
  })()
  let aborts = 0
  let settle = () => {}
  const completed = new Promise<void>((done) => {
    settle = done
  })
  const insert = options.interject ?? (async (claim, id) => ((await claim()) ? id : null))
  const turn: RunningTurn = {
    conversationId,
    turnId,
    mode: 'image',
    completed,
    read: (afterSeq) => eventLog.read(afterSeq),
    interject: (_text, _references, interjectOptions) =>
      insert(interjectOptions?.claim ?? (async () => true), interjectOptions?.messageId ?? 'fresh'),
    abort: () => {
      aborts += 1
      settle()
    },
  }
  const forget = registerRunningTurn(turn)
  const letGo = async () => {
    forget()
    settle()
    await eventLog.flush()
    eventLog.close()
  }
  live.push(letGo)
  return { turn, turnId, events, aborted: () => aborts, letGo }
}

/** 这一轮的事件流里撤下过哪几条，按发出的先后。 */
function withdrawnIds(running: TurnFake): string[] {
  return running.events.flatMap((event) =>
    event.type === 'queuedMessageWithdrawn' ? [event.queueId] : [],
  )
}

/** 每个用例收尾时都要放手的那几轮替身。 */
const live: Array<() => Promise<void>> = []
/** 这一批用例里上游被叫过几次：取件了没有，看它。 */
let calls: AgentCall[]

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  calls = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好的')))
})

afterEach(async () => {
  for (const letGo of live.splice(0)) await letGo()
  await db.delete(schema.agent_inbox)
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('发送', () => {
  it('会话忙时只排进收件箱并通知那一轮，不去取件', async () => {
    const conversationId = await conversation()
    const running = await runningTurnFake(conversationId)

    const sent = await sendToConversationInbox(conversationId, userMessage('再加一只狗'))

    expect(sent.kind).toBe('queued')
    if (sent.kind !== 'queued') throw new Error('unreachable')
    expect(sent.runningTurnId).toBe(running.turnId)
    expect(sent.entry.state).toBe('pending')
    expect(sent.entry.view.text).toBe('再加一只狗')
    // 连着的别的设备据此把它放进排队列表。
    await waitFor(() => running.events.some((event) => event.type === 'messageQueued'))
    // 没有去取件：上游一次都没被叫。
    expect(calls).toHaveLength(0)
  })

  it('会话闲着时当场开轮，那一条被这一轮取走', async () => {
    const conversationId = await conversation()

    const sent = await sendToConversationInbox(conversationId, userMessage('先画一只猫'))

    expect(sent.kind).toBe('started')
    if (sent.kind !== 'started') throw new Error('unreachable')
    await settled(sent.turn)
    expect(calls).toHaveLength(1)
  })
})

describe('撤回', () => {
  it('撤下排着的那一条，只通知一次；没有的那条就是没有', async () => {
    const conversationId = await conversation()
    const running = await runningTurnFake(conversationId)
    const queued = await queuedMessage(conversationId, '撤回这句')

    expect(await withdrawFromConversationInbox(conversationId, queued)).toBe('cancelled')

    // 再撤一次仍是同一个结局，但只有这一次撤下的才通知别的设备。
    expect(await withdrawFromConversationInbox(conversationId, queued)).toBe('cancelled')
    expect(await withdrawFromConversationInbox(conversationId, 'no-such-message')).toBe('not_found')
    await waitFor(() => running.events.some((event) => event.type === 'queuedMessageWithdrawn'))
    expect(running.events.filter((event) => event.type === 'queuedMessageWithdrawn')).toHaveLength(
      1,
    )
  })

  it('已经被取走的那一条撤不回，结局是已被处理', async () => {
    const conversationId = await conversation()
    const sent = await sendToConversationInbox(
      conversationId,
      userMessage('先画一只猫', 'client-1'),
    )
    if (sent.kind !== 'started') throw new Error('unreachable')
    // 同一个客户端消息 id 再发一次：交回的是那一条此刻的状态，不排第二次。
    const again = await sendToConversationInbox(
      conversationId,
      userMessage('先画一只猫', 'client-1'),
    )
    if (again.kind !== 'queued') throw new Error('unreachable')
    expect(again.entry.state).toBe('consumed')

    expect(await withdrawFromConversationInbox(conversationId, again.entry.view.id)).toBe(
      'already_consumed',
    )

    await settled(sent.turn)
  })
})

describe('升级为插话', () => {
  it('取走那一条再插进这一轮：它离开排队列表，连着的设备收到通知', async () => {
    const conversationId = await conversation()
    const running = await runningTurnFake(conversationId)
    const target = await queuedMessage(conversationId, '改成黑猫')
    const kept = await queuedMessage(conversationId, '先排着')

    const promoted = await promoteToInterjection(conversationId, target)

    expect(promoted).toEqual({ result: 'interjected', turnId: running.turnId })
    // 它离开排队列表；另一条仍排着，等这一轮结束。
    expect(await queueIds(conversationId)).toEqual([kept])
    await waitFor(() => running.events.some((event) => event.type === 'queuedMessageInterjected'))
  })

  it('没有在跑的轮、或没有这一条时升不了级', async () => {
    const conversationId = await conversation()
    const running = await runningTurnFake(conversationId)
    const target = await queuedMessage(conversationId, '排着的一句')
    await running.letGo()

    expect(await promoteToInterjection(conversationId, target)).toEqual({ result: 'not_running' })
    expect(await promoteToInterjection(conversationId, 'no-such-message')).toEqual({
      result: 'not_found',
    })
  })

  it('已经被撤回的那一条升不了级', async () => {
    const conversationId = await conversation()
    await runningTurnFake(conversationId)
    const target = await queuedMessage(conversationId, '撤回这句')
    await withdrawFromConversationInbox(conversationId, target)

    expect(await promoteToInterjection(conversationId, target)).toEqual({ result: 'cancelled' })
  })
})

describe('停止', () => {
  it('退回还排着的消息并通知别的设备，再中止这一轮', async () => {
    const conversationId = await conversation()
    const running = await runningTurnFake(conversationId)
    const one = await queuedMessage(conversationId, '第一句')
    const two = await queuedMessage(conversationId, '第二句')

    const stopped = await stopConversationTurn(conversationId, running.turnId)

    expect(stopped).toEqual({
      kind: 'stopped',
      returned: [
        { id: one, text: '第一句', references: [] },
        { id: two, text: '第二句', references: [] },
      ],
    })
    expect(await queueIds(conversationId)).toEqual([])
    expect(running.aborted()).toBe(1)
    await waitFor(() => withdrawnIds(running).length === 2)
    expect(withdrawnIds(running)).toEqual([one, two])
  })

  it('停止的响应丢了：重发拿回同一批，别的设备不会再收到一次撤下', async () => {
    const conversationId = await conversation()
    const running = await runningTurnFake(conversationId)
    const one = await queuedMessage(conversationId, '第一句')

    const first = await stopConversationTurn(conversationId, running.turnId)
    const again = await stopConversationTurn(conversationId, running.turnId)
    await running.letGo()
    const late = await stopConversationTurn(conversationId, running.turnId)

    expect(again).toEqual(first)
    expect(late).toEqual(first)
    expect(withdrawnIds(running)).toEqual([one])
  })

  it('没有这一轮、也没退回过消息时报没这一轮', async () => {
    const conversationId = await conversation()

    expect(await stopConversationTurn(conversationId, crypto.randomUUID())).toEqual({
      kind: 'no_such_turn',
    })
  })
})

describe('停止与升级为插话争同一条', () => {
  it('取走在路上时按下停止：那一条已经进了这一轮，停止不再退回它', async () => {
    const conversationId = await conversation()
    let running!: TurnFake
    let stopping: Promise<InboxStopResult> | undefined
    running = await runningTurnFake(conversationId, {
      interject: async (claim, id) => {
        // 取走已经在路上，这一刻按下停止。
        const claiming = claim()
        stopping = stopConversationTurn(conversationId, running.turnId)
        return (await claiming) ? id : null
      },
    })
    const target = await queuedMessage(conversationId, '改成黑猫')

    const promoted = await promoteToInterjection(conversationId, target)

    expect(promoted).toEqual({ result: 'interjected', turnId: running.turnId })
    // 停止等这一步落定，随后只退回它没抢到的那些。
    expect(await stopping).toEqual({ kind: 'stopped', returned: [] })
    expect(await queueIds(conversationId)).toEqual([])
  })

  it('停止先落定：升级取不走，那一条由停止退回', async () => {
    const conversationId = await conversation()
    let running!: TurnFake
    let stopped: InboxStopResult | undefined
    running = await runningTurnFake(conversationId, {
      interject: async (claim, id) => {
        // 插话进这一轮之前先按下停止：之后的取走一律不成立。
        stopped = await stopConversationTurn(conversationId, running.turnId)
        return (await claim()) ? id : null
      },
    })
    const target = await queuedMessage(conversationId, '改成黑猫')

    const promoted = await promoteToInterjection(conversationId, target)

    expect(promoted).toEqual({ result: 'cancelled' })
    expect(stopped).toEqual({
      kind: 'stopped',
      returned: [{ id: target, text: '改成黑猫', references: [] }],
    })
    expect(await queueIds(conversationId)).toEqual([])
  })

  it('取走之后插不进去：放回队里，接着开轮处理它', async () => {
    const conversationId = await conversation()
    let running!: TurnFake
    running = await runningTurnFake(conversationId, {
      interject: async (claim) => {
        await claim()
        // 取走之后这一轮刚好收尾：插不进去，也没有谁会再来取它。
        await running.letGo()
        return null
      },
    })
    const target = await queuedMessage(conversationId, '来晚的一句')

    const promoted = await promoteToInterjection(conversationId, target)

    expect(promoted).toEqual({ result: 'not_running' })
    // 放回去之后没人会再来取，所以这里接着开轮：它由新的一轮处理，且只处理一次。
    await waitFor(() => calls.length > 0, 3_000)
    expect(JSON.stringify(calls[0]!.messages)).toContain('来晚的一句')
    await waitFor(() => runningTurn(conversationId) === undefined, 3_000)
    expect(calls).toHaveLength(1)
    expect(await queueIds(conversationId)).toEqual([])
  })
})

describe('排队名额', () => {
  it(`排着的到 ${AGENT_QUEUE_MAX_PENDING} 条就收不下了`, async () => {
    const conversationId = await conversation()
    await runningTurnFake(conversationId)
    for (let index = 0; index < AGENT_QUEUE_MAX_PENDING; index += 1)
      await queuedMessage(conversationId, `第 ${index + 1} 句`)

    const overflow = await sendToConversationInbox(conversationId, userMessage('第十一句'))

    expect(overflow).toEqual({ kind: 'full' })
    expect(await queueIds(conversationId)).toHaveLength(AGENT_QUEUE_MAX_PENDING)
  })
})

describe('排进来的那句话得有人取', () => {
  it('会话忙时只通知那一轮', async () => {
    const conversationId = await conversation()
    const running = await runningTurnFake(conversationId)
    const notice = await noticeInInbox(conversationId, '用户已保存素材「小猫」')

    announceQueuedMessage(conversationId, notice)

    await waitFor(() => running.events.some((event) => event.type === 'messageQueued'))
    expect(calls).toHaveLength(0)
  })

  it('会话闲着时接着开轮处理它', async () => {
    const conversationId = await conversation()
    const notice = await noticeInInbox(conversationId, '用户已保存素材「小猫」')

    announceQueuedMessage(conversationId, notice)

    await waitFor(() => calls.length > 0, 3_000)
    expect(JSON.stringify(calls[0]!.messages)).toContain('用户已保存素材「小猫」')
    await waitFor(() => runningTurn(conversationId) === undefined, 3_000)
  })
})

describe('快照读到没人在跑', () => {
  it('队里还有人等着：接着开轮', async () => {
    const conversationId = await conversation()
    await noticeInInbox(conversationId, '没人处理的一句')

    await pickUpIdleConversation(conversationId, await queuedAgentMessages(conversationId))

    await waitFor(() => calls.length > 0, 3_000)
    expect(JSON.stringify(calls[0]!.messages)).toContain('没人处理的一句')
    await waitFor(() => runningTurn(conversationId) === undefined, 3_000)
  })
})
