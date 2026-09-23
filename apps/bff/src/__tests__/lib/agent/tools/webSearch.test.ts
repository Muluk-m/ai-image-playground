import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import type { ChatAttempt } from '../../../../lib/chatCompletion'

/**
 * 搜索是一次**额外的上游模型调用**，所以这个文件连着库跑：要钉的不只是「解析对了」，
 * 还有「这次调用的钱落进了 `agent_model_calls`，用途是 `web_search`」——那一位刚由
 * 0041 迁移放进 CHECK，拼错一个字母只会在生产里炸。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_web_search')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_SEARCH_MODEL = 'fixture-search-model'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../../agent-web-tools-operator-config.json',
)

// 动态引入：环境要先钉死，再让捕获配置的模块加载；静态 import 会在赋值之前就把配置读走。
const { webSearch } = await import('../../../../lib/agent/tools/webSearch')
const { setAgentSearchFetchForTesting } = await import('../../../../lib/agent/web-search')
const { createAgentUsageLedger } = await import('../../../../lib/agent/usage-ledger')
const { createAgentImageSource } = await import('../../../../lib/agent/images')
const { close: closeDb, db, schema } = await import('../../../../db/client')
const { agentTurnTools } = await import('../../../../lib/agent/tools')

const CONVERSATION = 'conversation-web-search'
const TURN = 'turn-1'
const DEVICE = 'device-abcdefgh'

// 线上的标注只圈住行尾那个「([站点](网址))」，网址还带着上游挂的 `utm_source=openai`。
const CITE_VITRA = '([vitra.com](https://www.vitra.com/eames-plastic-chair?utm_source=openai))'
const CITE_AERON = '([hermanmiller.com](https://www.hermanmiller.com/aeron?utm_source=openai))'
const SEARCH_TEXT = `1. **Vitra Eames Plastic Chair** — a moulded shell on wire legs, still in production. ${CITE_VITRA}\n2. **Herman Miller Aeron** — mesh office chair, 1994. ${CITE_AERON}`
const VITRA_AT = SEARCH_TEXT.indexOf(CITE_VITRA)
const AERON_AT = SEARCH_TEXT.indexOf(CITE_AERON)

/** 2026-09-23 线上那次调用的形状：`reasoning` / `web_search_call` 之后才是带标注的 `message`。 */
function responsesPayload() {
  return {
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: SEARCH_TEXT,
            annotations: [
              {
                type: 'url_citation',
                start_index: VITRA_AT,
                end_index: VITRA_AT + CITE_VITRA.length,
                title: 'Eames Plastic Chair | Vitra',
                url: 'https://www.vitra.com/eames-plastic-chair?utm_source=openai',
              },
              {
                type: 'url_citation',
                start_index: AERON_AT,
                end_index: AERON_AT + CITE_AERON.length,
                title: 'Aeron Chair | Herman Miller',
                url: 'https://www.hermanmiller.com/aeron?utm_source=openai',
              },
              // 同一个网址被引用两次只算一条来源。
              {
                type: 'url_citation',
                start_index: VITRA_AT,
                end_index: VITRA_AT + CITE_VITRA.length,
                title: 'Eames Plastic Chair | Vitra',
                url: 'https://www.vitra.com/eames-plastic-chair?utm_source=openai',
              },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 8_812, output_tokens: 214, input_tokens_details: { cached_tokens: 0 } },
  }
}

function respond(body: unknown, status = 200) {
  const raw = JSON.stringify(body)
  setAgentSearchFetchForTesting(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
  }))
}

function context() {
  const ledger = createAgentUsageLedger({
    conversationId: CONVERSATION,
    turnId: TURN,
    userId: null,
    deviceId: DEVICE,
  })
  return {
    mode: 'image' as const,
    conversationId: CONVERSATION,
    turnId: TURN,
    userId: null,
    deviceId: DEVICE,
    images: createAgentImageSource({
      references: [],
      history: [],
      conversationId: CONVERSATION,
      userId: null,
    }),
    // 生产里 turn.ts 就是这么接的：工具只管报告这次调用，用途由账本钉死。
    recordWebSearch: (attempt: ChatAttempt) => ledger.recordSideCall('web_search', attempt),
  }
}

function run(params: { query: string; count?: number }) {
  return webSearch.create(context()).execute('call-1', params, undefined, undefined)
}

function modelCalls() {
  return db
    .select()
    .from(schema.agent_model_calls)
    .where(eq(schema.agent_model_calls.conversation_id, CONVERSATION))
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
  await db.insert(schema.agent_conversations).values({
    id: CONVERSATION,
    device_id: DEVICE,
    title: '',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
})

afterAll(async () => {
  setAgentSearchFetchForTesting()
  await closeDb()
})

it('部署开了 agent:web、也配了搜索模型，模型这一轮就看得见搜索网页', () => {
  expect(agentTurnTools(context()).map((tool) => tool.name)).toContain('webSearch')
})

it('把引用标注读成来源，并按编号列表交回模型', async () => {
  respond(responsesPayload())

  const result = await run({ query: '经典椅子设计' })

  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('1. **Eames Plastic Chair | Vitra**')
  expect(text).toContain('https://www.vitra.com/eames-plastic-chair')
  expect(text).toContain('2. **Aeron Chair | Herman Miller**')
  // 说明取引用所在那一行的原话：不是标注圈住的那个引用链接，也不串到下一条。
  expect(text).toContain(
    '   Vitra Eames Plastic Chair — a moulded shell on wire legs, still in production.\n',
  )
  expect(text).toContain('   Herman Miller Aeron — mesh office chair, 1994.')
  expect(text).not.toContain('utm_source')
  expect(text).not.toContain('([vitra.com]')
  expect(result.details?.sources).toEqual([
    { title: 'Eames Plastic Chair | Vitra', url: 'https://www.vitra.com/eames-plastic-chair' },
    { title: 'Aeron Chair | Herman Miller', url: 'https://www.hermanmiller.com/aeron' },
  ])
})

it('按 count 截断结果条数', async () => {
  respond(responsesPayload())

  const result = await run({ query: '经典椅子设计', count: 1 })

  expect(result.details?.sources).toHaveLength(1)
})

it('把这次调用的用量记成本轮的 web_search 调用', async () => {
  respond(responsesPayload())

  await run({ query: '经典椅子设计' })

  expect(await modelCalls()).toEqual([
    expect.objectContaining({
      turn_id: TURN,
      device_id: DEVICE,
      purpose: 'web_search',
      model: 'fixture-search-model',
      status: 'completed',
      usage: { inputTokens: 8_812, outputTokens: 214 },
    }),
  ])
})

it('响应读不出结果时交回一个模型能自己绕开的失败，钱照记', async () => {
  respond({ output: [{ type: 'web_search_call', status: 'completed' }], usage: {} })

  await expect(run({ query: '经典椅子设计' })).rejects.toMatchObject({
    name: 'AgentToolError',
    code: 'no_output',
  })
  // 上游答了，这次调用的钱就已经花了：用量报不出来也要留下这条记录。
  expect(await modelCalls()).toEqual([
    expect.objectContaining({ purpose: 'web_search', status: 'completed', usage: null }),
  ])
})

it('上游报错时归到可重试的那一类', async () => {
  respond({ error: { message: 'bad gateway' } }, 502)

  await expect(run({ query: '经典椅子设计' })).rejects.toMatchObject({
    name: 'AgentToolError',
    code: 'upstream_error',
  })
})

it('搜索词是空白时不发请求', async () => {
  setAgentSearchFetchForTesting(async () => {
    throw new Error('搜索词为空时不该发请求')
  })

  await expect(run({ query: '   ' })).rejects.toMatchObject({
    name: 'AgentToolError',
    code: 'invalid_params',
  })
})
