import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentToolResultBlock, AgentTurnReference } from '@image-playground/shared'
import { AGENT_MAX_CONSECUTIVE_WAKES } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { type AgentCall, completionStream, recordingAgentFetch } from '../../helpers/agentStubs'
import { silenceChatUpstream } from '../../helpers/chatStubs'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_turn_preparation')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../agent-billing-operator-config.json',
)

const billing = installRecordingTaskHooks()

const { prepareAgentTurn } = await import('../../../lib/agent/turn-preparation')
const { startAgentTurn } = await import('../../../lib/agent/turn')
const { claimConversation, ConversationExecutionLost, releaseConversation, turnExecution } =
  await import('../../../lib/agent/execution')
const { chatTaskPricing, reservedChatUsage } = await import('../../../lib/agent/chat-task')
const { estimateTurnInputTokens, turnPromptBody } = await import('../../../lib/agent/turn-input')
const { setAgentFetchForTesting } = await import('../../../lib/agent/model')
const { appendAgentMessage, createAgentConversation } = await import(
  '../../../lib/agent/conversations'
)
const { enqueueAgentResume, enqueueAgentUserMessage, enqueueAgentWake, nextAgentInboxEntry } =
  await import('../../../lib/agent/inbox')
const { setAgentSkillsRootForTesting } = await import('../../../lib/agent/skills')
const { _setPrivateBffOverlayForTesting, loadPrivateBffOverlay } = await import(
  '../../../lib/private-overlay'
)
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../../db/client')

type AgentOwner = import('../../../lib/agent/conversations').AgentOwner
type AgentTurnSource = import('../../../lib/agent/turn-preparation').AgentTurnSource
type PreparedAgentTurn = import('../../../lib/agent/turn').PreparedAgentTurn
type TurnPreparation = import('../../../lib/agent/turn-preparation').TurnPreparation

await silenceChatUpstream()

const USER_ID = 'turn-preparation-user'
const DEVICE = 'device-abcdefgh'
const USER: AgentOwner = { kind: 'user', userId: USER_ID }
const SUBMITTING_TURN = 'turn-submitting'
const TASK_ID = 'task-1'
const REFERENCE: AgentTurnReference = {
  imageId: 'canvas-original',
  dataUrl: 'data:image/png;base64,aGk=',
}

let calls: AgentCall[]
let storage: InMemoryObjectStore

/** 一条已经结算成终局的结果卡：唤醒点名的就是它。 */
function resultBlock(artifacts: readonly string[]): AgentToolResultBlock {
  return {
    type: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    status: 'succeeded',
    title: '生成图片',
    prompt: '一只橘猫',
    job: { taskId: TASK_ID, media: 'image', review: true },
    ...(artifacts.length
      ? {
          artifacts: artifacts.map((artifactId, outputIndex) => ({
            artifactId,
            media: 'image' as const,
            taskId: TASK_ID,
            outputIndex,
            mime: 'image/png',
          })),
        }
      : {}),
  }
}

/** 一个会话，外加提交那一轮的用户原话与结果卡：唤醒与续跑都点名它。 */
async function conversationWithResult(artifacts: readonly string[] = []): Promise<string> {
  const conversation = await createAgentConversation(USER, '画一只橘猫')
  await appendAgentMessage(db, {
    conversationId: conversation.id,
    turnId: SUBMITTING_TURN,
    role: 'user',
    content: [{ type: 'text', text: '画一只橘猫' }],
  })
  await appendAgentMessage(db, {
    conversationId: conversation.id,
    turnId: SUBMITTING_TURN,
    role: 'assistant',
    content: [resultBlock(artifacts)],
  })
  return conversation.id
}

/** 领租约、准备一轮；`turnId` 与真实起轮一样是这一轮自己的 id。 */
async function prepare(
  conversationId: string,
  source: AgentTurnSource,
  owner: AgentOwner = USER,
  assertOwnership: () => Promise<void> = async () => {},
): Promise<{ readonly prepared: TurnPreparation; readonly turnId: string }> {
  const turnId = crypto.randomUUID()
  expect(await claimConversation(conversationId, turnId)).toBe(true)
  const prepared = await prepareAgentTurn({
    conversationId,
    owner,
    turnId,
    execution: turnExecution(conversationId, turnId, assertOwnership),
    source,
  })
  return { prepared, turnId }
}

function preparedTurn(prepared: TurnPreparation): PreparedAgentTurn {
  if (prepared.kind !== 'prepared')
    throw new Error(`expected a prepared turn, got ${prepared.kind}`)
  return prepared.turn
}

/** 排一条用户消息进收件箱，交回起轮准备要的那一份来源。 */
async function queuedMessage(
  conversationId: string,
  text: string,
  references: readonly AgentTurnReference[] = [],
): Promise<Extract<AgentTurnSource, { kind: 'message' }>> {
  const enqueued = await enqueueAgentUserMessage(conversationId, {
    clientMessageId: crypto.randomUUID(),
    text,
    deviceId: DEVICE,
    references,
  })
  if (enqueued.kind !== 'queued') throw new Error(`expected a queued message, got ${enqueued.kind}`)
  return {
    kind: 'message',
    message: {
      id: enqueued.entry.view.id,
      clientMessageId: enqueued.entry.view.clientMessageId,
      text,
      deviceId: DEVICE,
      references,
    },
    announce: false,
  }
}

async function queuedWake(
  conversationId: string,
): Promise<Extract<AgentTurnSource, { kind: 'wake' }>> {
  await db.transaction((tx) =>
    enqueueAgentWake(
      tx,
      conversationId,
      { turnId: SUBMITTING_TURN, taskIds: [TASK_ID], deviceId: DEVICE },
      Date.now(),
    ),
  )
  const next = await nextAgentInboxEntry(conversationId)
  if (next?.kind !== 'task_result') throw new Error('expected a queued wake')
  const { kind: _kind, ...wake } = next
  return { kind: 'wake', wake }
}

async function queuedResume(
  conversationId: string,
  interruptedTurnId: string,
): Promise<Extract<AgentTurnSource, { kind: 'resume' }>> {
  expect(
    await enqueueAgentResume(conversationId, {
      interruptedTurnId,
      deviceId: DEVICE,
      mode: 'image',
    }),
  ).toBe(true)
  const next = await nextAgentInboxEntry(conversationId)
  if (next?.kind !== 'resume') throw new Error('expected a queued resume')
  const { kind: _kind, ...resume } = next
  return { kind: 'resume', resume }
}

/** 这一轮真正发给上游的那条 prompt 的文字。 */
function sentPromptText(call: AgentCall): string {
  const content = call.messages.at(-1)?.content
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const first = content[0] as { type?: string; text?: string } | undefined
  return first?.type === 'text' ? (first.text ?? '') : ''
}

/** 起这一轮并等它收尾，交回上游收到的第一次请求。 */
async function runPrepared(turn: PreparedAgentTurn): Promise<AgentCall> {
  const running = await startAgentTurn(turn)
  for await (const _stored of running.read(0)) {
    // 读到终帧为止：落库与结算都在这之前做完。
  }
  const call = calls[0]
  if (!call) throw new Error('the turn never reached the upstream')
  return call
}

/** 一条临时技能，只为验 `/skill-name` 的展开；不跟着仓库里发的那几条一起变。 */
const SKILL_NAME = 'fixture-skill'
const SKILL_BODY = '固定夹具技能的正文'
let skillsRoot = ''

beforeAll(async () => {
  skillsRoot = await mkdtemp(join(tmpdir(), 'aip-turn-preparation-'))
  const dir = join(skillsRoot, 'image', SKILL_NAME)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: 何时用：跑这条夹具。不处理：别的。\n---\n\n# 夹具技能\n\n${SKILL_BODY}\n`,
    'utf8',
  )
  setAgentSkillsRootForTesting(skillsRoot)
})

beforeEach(async () => {
  billing.reset()
  calls = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好')))
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.agent_executions)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'turn.preparation',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  setAgentSkillsRootForTesting(null)
  if (skillsRoot) await rm(skillsRoot, { recursive: true, force: true })
  await closeDb()
})

/**
 * 「预扣时的估算看到的就是实际发出的内容」：两条路都从 `prepared.input` 这一份轮输入派生，
 * 所以每一种来源都要能证明发出去的那段文字以同一份正文开头。
 */
describe('估算看到的就是发出去的那一份', () => {
  it('用户消息这一轮', async () => {
    const conversationId = await conversationWithResult()
    const { prepared } = await prepare(
      conversationId,
      await queuedMessage(conversationId, '换成夜景'),
    )
    const turn = preparedTurn(prepared)

    const call = await runPrepared(turn)

    const body = turnPromptBody(turn.input)
    expect(body).toBe('换成夜景')
    expect(sentPromptText(call).startsWith(body)).toBe(true)
  })

  it('唤醒这一轮，连同要复核的产物', async () => {
    const conversationId = await conversationWithResult(['agent_task-1_0'])
    const { prepared } = await prepare(conversationId, await queuedWake(conversationId))
    const turn = preparedTurn(prepared)

    const call = await runPrepared(turn)

    const body = turnPromptBody(turn.input)
    // 唤醒的文字是一段系统说明，不是用户的话；要复核的产物跟着这一份走。
    expect(body).toContain('需要复核的任务')
    expect(turn.input.reviewImageIds).toEqual(['agent_task-1_0'])
    expect(sentPromptText(call).startsWith(body)).toBe(true)
  })

  it('中断续跑这一轮', async () => {
    const conversationId = await conversationWithResult()
    const { prepared } = await prepare(
      conversationId,
      await queuedResume(conversationId, SUBMITTING_TURN),
    )
    const turn = preparedTurn(prepared)

    const call = await runPrepared(turn)

    const body = turnPromptBody(turn.input)
    expect(body).toContain('上一轮')
    expect(sentPromptText(call).startsWith(body)).toBe(true)
  })

  /**
   * 并进来的唤醒说明排在**引用清单之后**。从前估算拼的是「原话 + 说明」再接清单，实发拼的是
   * 「原话 + 清单」再接说明——同样的字、不同的次序，估算看到的并不是发出去的那一份。
   */
  it('并进唤醒说明的那一轮：说明排在引用清单之后', async () => {
    const conversationId = await conversationWithResult(['agent_task-1_0'])
    await queuedWake(conversationId)
    const { prepared } = await prepare(
      conversationId,
      await queuedMessage(conversationId, '顺便把背景换成蓝色', [REFERENCE]),
    )
    const turn = preparedTurn(prepared)

    const call = await runPrepared(turn)

    const body = turnPromptBody(turn.input)
    const note = '先回应用户这条消息'
    expect(body.startsWith('顺便把背景换成蓝色')).toBe(true)
    expect(body.indexOf('[image 1]')).toBeLessThan(body.indexOf(note))
    expect(turn.input.reviewImageIds).toEqual(['agent_task-1_0'])
    expect(sentPromptText(call).startsWith(body)).toBe(true)
  })

  /**
   * `/skill-name` 只改送给模型的那一份。并进来的说明排在技能正文之后，不在 `<skill>` 里面——
   * 从前估算把「原话 + 说明」整段交给技能展开，说明因此被吞进技能正文，与实发那一份并不相同。
   */
  it('显式调用技能、同时并进唤醒说明的那一轮', async () => {
    const conversationId = await conversationWithResult()
    await queuedWake(conversationId)
    const { prepared } = await prepare(
      conversationId,
      await queuedMessage(conversationId, `/${SKILL_NAME} 出一张主图`),
    )
    const turn = preparedTurn(prepared)

    const call = await runPrepared(turn)

    const body = turnPromptBody(turn.input)
    const note = '先回应用户这条消息'
    expect(body).toContain(SKILL_BODY)
    expect(body).toContain('出一张主图')
    expect(body.indexOf('</skill>')).toBeLessThan(body.indexOf(note))
    expect(sentPromptText(call).startsWith(body)).toBe(true)
  })
})

describe('预扣按这一份轮输入算', () => {
  it('记到账上的计价用量，就是这一份轮输入折算出来的那一份', async () => {
    const conversationId = await conversationWithResult()
    const pricing = await chatTaskPricing(
      (await loadPrivateBffOverlay()).taskHooks,
      'fixture-agent-model',
    )

    const { prepared } = await prepare(
      conversationId,
      await queuedMessage(conversationId, '换成夜景'),
    )
    const turn = preparedTurn(prepared)

    expect(billing.reservations).toHaveLength(1)
    // 账上那一笔的量由这一份轮输入定：换成别处算的估算，下面这行就对不上。
    expect(billing.reservations[0]).toMatchObject({
      taskId: turn.turnId,
      userId: USER_ID,
      model: 'fixture-agent-model',
      ...reservedChatUsage(estimateTurnInputTokens(turn.input), pricing),
    })
  })

  /** 带着说明预扣不下时整段丢掉：唤醒的费用不能挡住用户的话。 */
  it('带说明预扣不下就丢掉说明，用户的话照常开轮', async () => {
    const conversationId = await conversationWithResult()
    await queuedWake(conversationId)
    const before = billing.reservations.length
    billing.decide = () =>
      billing.reservations.length - before === 1
        ? { kind: 'insufficient_credits', required: 50, available: 30 }
        : { kind: 'reserved', credits: 30 }

    const { prepared } = await prepare(
      conversationId,
      await queuedMessage(conversationId, '顺便把背景换成蓝色'),
    )
    const turn = preparedTurn(prepared)

    expect(turn.input.note).toBeUndefined()
    expect(turnPromptBody(turn.input)).toBe('顺便把背景换成蓝色')
    // 说明没进这一轮，那条唤醒就留在收件箱里，之后走它自己的路。
    const [wake] = await db
      .select()
      .from(schema.agent_inbox)
      .where(eq(schema.agent_inbox.kind, 'task_result'))
    expect(wake?.status).toBe('pending')
    // 先带说明估一次、被拒后按用户这条消息自己再估一次，两次记在同一轮上。
    const tries = billing.reservations.slice(before)
    expect(tries).toHaveLength(2)
    expect(tries[0]!.unitMultiplier).toBeGreaterThan(tries[1]!.unitMultiplier)
  })
})

/** 参考图在取件事务之前就落进了对象存储，所以清不清只看那一笔事务成没成。 */
describe('起轮准备半路出错', () => {
  it('事务没成：这一轮归档的参考图跟着一起清掉', async () => {
    billing.answer = { kind: 'insufficient_credits', required: 78, available: 12 }
    const conversation = await createAgentConversation(USER, '你好')
    const source = await queuedMessage(conversation.id, '[image 1] 看这张图', [REFERENCE])

    const { prepared } = await prepare(conversation.id, source)

    expect(prepared.kind).toBe('insufficient_credits')
    expect(await storage.listPrefix(`agent/${conversation.id}/`)).toEqual([])
  })

  /**
   * 事务提交之后租约才被接管：那条用户消息已经落库、正指着刚归档的参考图，一张都不能删，
   * 否则历史里留下一条引用打不开的消息。
   */
  it('提交之后才丢租约：落好的用户消息与它的参考图都留着', async () => {
    const conversation = await createAgentConversation(USER, '你好')
    const source = await queuedMessage(conversation.id, '[image 1] 看这张图', [REFERENCE])

    let asserted = 0
    await expect(
      prepare(conversation.id, source, USER, async () => {
        asserted += 1
        throw new ConversationExecutionLost()
      }),
    ).rejects.toThrow(ConversationExecutionLost)

    expect(asserted).toBe(1)
    expect(await db.select().from(schema.agent_messages)).toHaveLength(1)
    expect(await storage.listPrefix(`agent/${conversation.id}/`)).not.toEqual([])
  })
})

describe('开不了轮', () => {
  it('计费部署里匿名设备开不了轮，也不预扣', async () => {
    const conversation = await createAgentConversation({ kind: 'device', deviceId: DEVICE }, '你好')
    const source = await queuedMessage(conversation.id, '换成夜景')

    const { prepared } = await prepare(conversation.id, source, {
      kind: 'device',
      deviceId: DEVICE,
    })

    expect(prepared).toEqual({ kind: 'authentication_required' })
    expect(billing.reservations).toHaveLength(0)
  })

  it('余额不足时整笔回滚：那一条原样待处理，也不落用户消息', async () => {
    billing.answer = { kind: 'insufficient_credits', required: 78, available: 12 }
    const conversation = await createAgentConversation(USER, '你好')
    const source = await queuedMessage(conversation.id, '换成夜景')

    const { prepared } = await prepare(conversation.id, source)

    expect(prepared).toEqual({ kind: 'insufficient_credits', required: 78, available: 12 })
    expect(await nextAgentInboxEntry(conversation.id)).toMatchObject({ kind: 'user_message' })
    expect(await db.select().from(schema.agent_messages)).toHaveLength(0)
    expect(await db.select().from(schema.tasks)).toEqual([])
  })

  it('对话模型没有有效单价时开不了轮', async () => {
    billing.answer = { kind: 'price_unavailable', model: 'fixture-agent-model' }
    const conversation = await createAgentConversation(USER, '你好')

    const { prepared } = await prepare(
      conversation.id,
      await queuedMessage(conversation.id, '换成夜景'),
    )

    expect(prepared).toEqual({ kind: 'price_unavailable', model: 'fixture-agent-model' })
  })

  it('收件箱那一条已经被别处取走：什么都不落', async () => {
    const conversation = await createAgentConversation(USER, '你好')
    const source = await queuedMessage(conversation.id, '换成夜景')
    await db
      .update(schema.agent_inbox)
      .set({ status: 'cancelled' })
      .where(eq(schema.agent_inbox.id, source.message.id))

    const { prepared } = await prepare(conversation.id, source)

    expect(prepared).toEqual({ kind: 'withdrawn' })
    expect(billing.reservations).toHaveLength(0)
  })

  it('唤醒点名的结果卡一张都不在：没有可看的', async () => {
    const conversation = await createAgentConversation(USER, '你好')

    const { prepared } = await prepare(conversation.id, await queuedWake(conversation.id))

    expect(prepared).toEqual({ kind: 'no_results' })
    expect(billing.reservations).toHaveLength(0)
  })

  it('连续自动唤醒到了上限就不再起轮', async () => {
    const conversationId = await conversationWithResult()
    // 用户上次说话之后已经连着跑过这么多轮唤醒：取走了唤醒、自己没有用户消息、留下了页脚。
    for (let index = 0; index < AGENT_MAX_CONSECUTIVE_WAKES; index += 1) {
      const turnId = `wake-turn-${index}`
      const id = await db.transaction((tx) =>
        enqueueAgentWake(
          tx,
          conversationId,
          { turnId: SUBMITTING_TURN, taskIds: [TASK_ID], deviceId: DEVICE },
          Date.now() + 1_000,
        ),
      )
      await db
        .update(schema.agent_inbox)
        .set({ status: 'consumed', consumed_turn_id: turnId })
        .where(eq(schema.agent_inbox.id, id))
      await db.insert(schema.agent_turns).values({
        conversation_id: conversationId,
        turn_id: turnId,
        duration_ms: 1,
        stop_reason: 'completed',
        created_at: Date.now() + 1_000,
      })
    }

    const { prepared } = await prepare(conversationId, await queuedWake(conversationId))

    expect(prepared).toEqual({ kind: 'wake_limit' })
    expect(billing.reservations).toHaveLength(0)
  })
})

describe('这一轮的创作类型', () => {
  it('没说创作类型的消息是图片轮', async () => {
    const conversation = await createAgentConversation(USER, '你好')

    const { prepared } = await prepare(
      conversation.id,
      await queuedMessage(conversation.id, '画一只猫'),
    )

    expect(preparedTurn(prepared).input.mode).toBe('image')
  })
})

/** 起轮准备落下的用户消息与首轮标题。 */
describe('用户消息落库', () => {
  it('取走那一条、落他的原话，首轮标题取那句话', async () => {
    const conversation = await createAgentConversation(USER, '')
    const source = await queuedMessage(conversation.id, '把背景换成浅木色')

    const { prepared, turnId } = await prepare(conversation.id, source)
    const turn = preparedTurn(prepared)
    await releaseConversation(conversation.id, turnId)

    expect(turn.userMessageId).toBe(source.message.id)
    const [message] = await db.select().from(schema.agent_messages)
    expect(message).toMatchObject({ id: source.message.id, role: 'user', turn_id: turnId })
    const [row] = await db
      .select()
      .from(schema.agent_conversations)
      .where(eq(schema.agent_conversations.id, conversation.id))
    expect(row?.title).toBe('把背景换成浅木色')
    expect(await nextAgentInboxEntry(conversation.id)).toBeNull()
  })
})
