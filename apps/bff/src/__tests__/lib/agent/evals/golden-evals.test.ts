/**
 * 对话式生图 Agent 黄金评测集。
 *
 * 钉住运行时的确定性行为（工具表面、直出跳过模型、提示词是否改写、出图/确认模式、
 * 系统事实、同错误熔断、过载重试）。模型输出全部脚本化，不打真实上游、不跑 worker。
 * 怎么加用例见同目录 README.md。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { and, eq } from 'drizzle-orm'
import {
  type AgentCall,
  completionStream,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../../../helpers/agentStubs'
import { silenceChatUpstream } from '../../../helpers/chatStubs'
import { InMemoryObjectStore } from '../../../helpers/inMemoryObjectStore'
import { waitFor } from '../../../helpers/upstreamStubs'
import {
  DESIGN_HEAD,
  DEVICE,
  type EvalClient,
  lastUserText,
  overloadedResponse,
  runTurn,
  STRUCTURED_ENGLISH_PROMPT,
  snapshotMessages,
  startConversation,
  toolCards,
  toolNamesOf,
  USER_ID,
} from './harness'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_golden_evals')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.LOG_LEVEL = 'silent'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../evals-operator-config.json')

const { app } = await import('../../../../app')
const { setAgentFetchForTesting, setAgentRetryBackoffForTesting } = await import(
  '../../../../lib/agent/model'
)
setAgentRetryBackoffForTesting(0)
const { AGENT_TOOL_FAILURE_STREAK_LIMIT } = await import('../../../../lib/agent/tools')
const { _setChannelsForTesting } = await import('../../../../lib/channels')
const { setObjectStoreForTesting } = await import('../../../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../../../lib/user-session')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../../../lib/private-overlay'
)

await silenceChatUpstream()
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const client: EvalClient = { app, cookie: '' }
let calls: AgentCall[] = []

async function idle(conversationId: string): Promise<void> {
  await waitFor(async () => {
    const [row] = await db
      .select({ state: schema.agent_executions.state })
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversationId))
    return row?.state !== 'running'
  }, 5_000)
}

function queueTasks(conversationId: string) {
  return db
    .select()
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.agent_conversation_id, conversationId), eq(schema.tasks.kind, 'queue')),
    )
}

async function seedPendingDraft(conversationId: string, prompt: string): Promise<void> {
  await db.insert(schema.agent_generation_drafts).values({
    id: `draft-${crypto.randomUUID()}`,
    conversation_id: conversationId,
    turn_id: 'seed-turn',
    tool_call_id: 'seed-draft',
    tool_name: 'generateImage',
    media: 'image',
    provider: 'openai-compat',
    model: 'fixture',
    prompt,
    request: { prompt, device_id: DEVICE, n: 1 },
    submission: { review: false },
    created_at: Date.now(),
  })
}

async function seedCompletedBatch(conversationId: string, batchId: string): Promise<void> {
  const now = Date.now()
  await db.insert(schema.agent_batches).values({
    id: batchId,
    user_id: USER_ID,
    conversation_id: conversationId,
    origin_turn_id: 'origin',
    tool_call_id: batchId,
    experience: 'chat',
    status: 'closed',
    current_version: 1,
    confirmed_version: 1,
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.agent_batch_plans).values({
    batch_id: batchId,
    version: 1,
    title: '秋日海报批次',
    rule: 'rule',
    digest: 'a'.repeat(64),
    item_count: 2,
    estimate_snapshot: {
      analysis: {
        status: 'available',
        estimatedCredits: 0,
        estimatedChargeCredits: 0,
        snapshots: [],
      },
      generation: {
        status: 'available',
        estimatedCredits: 0,
        estimatedChargeCredits: 0,
        snapshots: [],
      },
    },
    created_at: now,
  })
  for (const index of [0, 1]) {
    const key = `item-${index}`
    const taskId = `${batchId}-task-${index}`
    await db.insert(schema.agent_batch_items).values({
      batch_id: batchId,
      version: 1,
      key,
      ordinal: index,
      kind: 'generation',
      inputs: [],
      prompt: 'prompt',
      params: { model: 'fixture', provider: 'openai-compat' },
      dependencies: [],
    })
    await db.insert(schema.tasks).values({
      id: taskId,
      user_id: USER_ID,
      provider: 'openai-compat',
      model: 'fixture',
      status: 'completed',
      request_payload: { device_id: DEVICE, prompt: 'prompt', n: 1 },
      submitted_at: now + index,
    })
    await db.insert(schema.agent_batch_attempts).values({
      batch_id: batchId,
      version: 1,
      item_key: key,
      attempt: 1,
      task_id: taskId,
      reserved_credits: 100,
      submitted_at: now + index,
    })
  }
}

beforeAll(async () => {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'golden.eval',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  client.cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(USER_ID, tx))}`
})

beforeEach(async () => {
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  calls = []
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
  _setChannelsForTesting([])
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('黄金评测：工具表面', () => {
  it('canvas-forbids-batch-tools：画布模式不提供 planImageBatch / proposeBatchGeneration', async () => {
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好的')]))
    const conversationId = await startConversation(client)
    await runTurn(
      client,
      conversationId,
      { text: '帮我在画布上出一组主图', experience: 'canvas' },
      idle,
    )
    const canvasTools = toolNamesOf(calls[0]!)
    expect(canvasTools).toContain('readCanvas')
    expect(canvasTools).not.toContain('planImageBatch')
    expect(canvasTools).not.toContain('proposeBatchGeneration')
    expect(canvasTools).not.toContain('generateImage')

    calls.length = 0
    const chatId = await startConversation(client)
    await runTurn(client, chatId, { text: '帮我规划一批主图', experience: 'chat' }, idle)
    const chatTools = toolNamesOf(calls[0]!)
    expect(chatTools).toContain('planImageBatch')
    expect(chatTools).toContain('proposeBatchGeneration')
    expect(chatTools).toContain('generateImage')
  })
})

describe('黄金评测：直出与提示词', () => {
  it('direct-image-skips-model：结构化英文 prompt 直出不先问模型、不填 designIntent、不改写', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [() => completionStream('已经按原文提交了。')]),
    )
    const conversationId = await startConversation(client)
    await runTurn(
      client,
      conversationId,
      {
        text: STRUCTURED_ENGLISH_PROMPT,
        params: { directImage: true, autoSubmit: true },
        experience: 'chat',
      },
      idle,
    )
    const cards = toolCards(await snapshotMessages(client, conversationId))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      toolName: 'generateImage',
      prompt: STRUCTURED_ENGLISH_PROMPT,
    })
    expect(cards[0]!.prompt).not.toContain(DESIGN_HEAD)
    // 直出先本地拼出 generateImage；若之后还问模型，那次请求里已经带上这次工具调用。
    for (const call of calls) {
      expect(JSON.stringify(call.messages)).toContain('generateImage')
    }
    const [task] = await queueTasks(conversationId)
    expect(task).toBeDefined()
    expect(task!.request_payload).toMatchObject({ prompt: STRUCTURED_ENGLISH_PROMPT })
  })

  it('design-intent-rewrite：模型填写完整 designIntent 时运行时并入最终提示词', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'gen-1',
            name: 'generateImage',
            args: {
              prompt: STRUCTURED_ENGLISH_PROMPT,
              designIntent: {
                message: '让观众感到午后咖啡的余裕',
                focalPoint: '红色珐琅壶',
              },
            },
          }),
      ]),
    )
    const conversationId = await startConversation(client)
    await runTurn(
      client,
      conversationId,
      { text: '画一把红色珐琅壶', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    const [card] = toolCards(await snapshotMessages(client, conversationId))
    expect(card?.toolName).toBe('generateImage')
    expect(card?.prompt).toContain(DESIGN_HEAD)
    expect(card?.prompt).toContain('让观众感到午后咖啡的余裕')
    expect(card?.prompt).toContain(STRUCTURED_ENGLISH_PROMPT)
  })
})

describe('黄金评测：出图模式与确认模式', () => {
  it('confirm-mode-drafts：未开 autoSubmit 时只拟稿、不入队', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'draft-1',
            name: 'generateImage',
            args: { prompt: '一只戴围巾的橘猫' },
          }),
      ]),
    )
    const conversationId = await startConversation(client)
    await runTurn(
      client,
      conversationId,
      { text: '画一只戴围巾的橘猫', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    const [card] = toolCards(await snapshotMessages(client, conversationId))
    expect(card).toMatchObject({
      toolName: 'generateImage',
      status: 'awaiting_confirmation',
      prompt: '一只戴围巾的橘猫',
    })
    expect(await queueTasks(conversationId)).toEqual([])
  })

  it('generate-mode-enqueues：出图模式当场入队', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'gen-1',
            name: 'generateImage',
            args: { prompt: '一只戴围巾的橘猫' },
          }),
        () => completionStream('已经提交了。'),
      ]),
    )
    const conversationId = await startConversation(client)
    await runTurn(
      client,
      conversationId,
      { text: '画一只戴围巾的橘猫', params: { autoSubmit: true }, experience: 'chat' },
      idle,
    )
    const [card] = toolCards(await snapshotMessages(client, conversationId))
    expect(card?.toolName).toBe('generateImage')
    expect(card?.status).not.toBe('awaiting_confirmation')
    expect(card?.job?.taskId).toBeDefined()
    const tasks = await queueTasks(conversationId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.request_payload).toMatchObject({ prompt: '一只戴围巾的橘猫' })
  })
})

describe('黄金评测：系统事实', () => {
  it('system-facts-pending-draft：待确认草稿写入本轮用户消息', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [() => completionStream('还请在卡片上确认。')]),
    )
    const conversationId = await startConversation(client)
    await seedPendingDraft(conversationId, '把浴缸换成图2的款式')
    await runTurn(
      client,
      conversationId,
      { text: '现在进度怎么样？', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    expect(calls).toHaveLength(1)
    const user = lastUserText(calls[0]!)
    expect(user).toContain('（系统事实，不是用户说的话）本会话当前状态：')
    expect(user).toContain('待用户在卡片上确认的生成')
    expect(user).toContain('把浴缸换成图2的款式')
    expect(user).toContain('现在进度怎么样？')
  })

  it('system-facts-completed-batch：已完成批次写入系统事实并附短确认语指引', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [() => completionStream('这一批已经出完了。')]),
    )
    const conversationId = await startConversation(client)
    await seedCompletedBatch(conversationId, 'batch-done')
    await runTurn(
      client,
      conversationId,
      { text: '还缺哪张？', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    const user = lastUserText(calls[0]!)
    expect(user).toContain('批次 batch-done「秋日海报批次」：已执行完毕，完成 2/2')
    expect(user).toContain('用户只说“确认”“可以”“执行”“开始生成”这类话时')
    expect(user).toContain('不要为这类话重新调用生成工具')
  })
})

describe('黄金评测：容错', () => {
  it('tool-same-error-circuit：同一错误连续失败后停止再执行该工具', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'f1', name: 'webFetch', args: { url: '   ' } }),
        () => toolCallCompletion({ id: 'f2', name: 'webFetch', args: { url: '   ' } }),
        () => toolCallCompletion({ id: 'f3', name: 'webFetch', args: { url: '   ' } }),
        () => toolCallCompletion({ id: 'f4', name: 'webFetch', args: { url: '   ' } }),
        () => completionStream('我不再重试了。'),
      ]),
    )
    const conversationId = await startConversation(client)
    await runTurn(
      client,
      conversationId,
      { text: '读一下这个网址', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    expect(calls.length).toBeGreaterThanOrEqual(4)
    const fourthResult = JSON.stringify(calls[4]?.messages ?? calls.at(-1)?.messages)
    expect(fourthResult).toContain(
      `webFetch 在这一轮已连续 ${AGENT_TOOL_FAILURE_STREAK_LIMIT} 次以同样的错误失败，已停止重试`,
    )
  })

  it('overload-no-output-retry：产出前过载会重试，成功后用户看到完整回复', async () => {
    let fetches = 0
    setAgentFetchForTesting(async () => {
      fetches += 1
      return fetches === 1 ? overloadedResponse() : completionStream('好的，我来帮你改背景。')
    })
    const conversationId = await startConversation(client)
    await runTurn(
      client,
      conversationId,
      { text: '把背景换成蓝色', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    expect(fetches).toBe(2)
    const messages = await snapshotMessages(client, conversationId)
    const assistant = messages.filter((message) => message.role === 'assistant')
    expect(
      assistant.some((message) =>
        JSON.stringify(message.content).includes('好的，我来帮你改背景。'),
      ),
    ).toBe(true)
  })
})

const GENERATION_TOOLS = [
  'generateImage',
  'editImage',
  'generateVideo',
  'runNodes',
  'planImageBatch',
  'proposeBatchGeneration',
  'runStoryboardFrames',
] as const

describe('黄金评测：短确认语（拦截后）', () => {
  it('short-confirmation-current：批次完成后短确认语被拦截，不再问模型，并给出固定回复', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'should-not-run',
            name: 'generateImage',
            args: { prompt: '确认，执行生成' },
          }),
      ]),
    )
    const conversationId = await startConversation(client)
    await seedCompletedBatch(conversationId, 'batch-confirmed')
    await runTurn(
      client,
      conversationId,
      { text: '确认，执行生成', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    expect(calls).toHaveLength(0)
    const messages = await snapshotMessages(client, conversationId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain('这批已经出完了，不用再确认执行，我不会重新提交生成。')
    expect(serialized).toContain('批次 batch-confirmed「秋日海报批次」已完成 2/2')
    expect(toolCards(messages).map((card) => card.toolName)).toEqual([])
    expect(await queueTasks(conversationId)).toEqual([])
  })

  it('short-confirmation-intercept：批次已完成后说「确认，执行生成」不应再调对话模型或生成工具', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'should-not-run',
            name: 'generateImage',
            args: { prompt: '确认，执行生成' },
          }),
      ]),
    )
    const conversationId = await startConversation(client)
    await seedCompletedBatch(conversationId, 'batch-intercept')
    await runTurn(
      client,
      conversationId,
      { text: '确认，执行生成', params: { autoSubmit: false }, experience: 'chat' },
      idle,
    )
    expect(calls).toHaveLength(0)
    const cards = toolCards(await snapshotMessages(client, conversationId))
    for (const name of GENERATION_TOOLS) {
      expect(cards.some((card) => card.toolName === name)).toBe(false)
    }
    expect(await queueTasks(conversationId)).toEqual([])
    const drafts = await db
      .select()
      .from(schema.agent_generation_drafts)
      .where(eq(schema.agent_generation_drafts.conversation_id, conversationId))
    expect(drafts).toEqual([])
  })
})
