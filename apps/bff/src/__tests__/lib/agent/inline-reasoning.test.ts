import { afterEach, expect, it } from 'bun:test'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { completionStream, replyThenToolCall } from '../../helpers/agentStubs'

process.env.DATABASE_URL = 'postgres://unused/inline-reasoning'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'gpt-6-luna'
process.env.OPERATOR_CONFIG_FILE = ''
const { agentModel, agentStreamFn, setAgentFetchForTesting } = await import(
  '../../../lib/agent/model'
)
const { rewriteInlineReasoning, withInlineReasoning } = await import(
  '../../../lib/agent/inline-reasoning'
)
afterEach(() => setAgentFetchForTesting())

async function run(response: () => Response, modelId?: string) {
  setAgentFetchForTesting(async () => response())
  const base = agentModel('fast')
  const model = modelId ? { ...base, id: modelId, name: modelId } : base
  const stream = await agentStreamFn('fast')(model, {
    messages: [{ role: 'user', content: '出图', timestamp: 1 }],
  })
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return { events, result: await stream.result() }
}

const textDeltas = (events: AssistantMessageEvent[]) =>
  events.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')
const thinkingDeltas = (events: AssistantMessageEvent[]) =>
  events.flatMap((event) => (event.type === 'thinking_delta' ? [event.delta] : [])).join('')

it('turns a leading thinking tag split across chunks into a thinking block', async () => {
  const { events, result } = await run(() =>
    completionStream('<thi', 'nking>Reading canvas', ' to confirm</thin', 'king>\n已开始出图。'),
  )
  expect(textDeltas(events)).toBe('已开始出图。')
  expect(thinkingDeltas(events)).toBe('Reading canvas to confirm')
  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'Reading canvas to confirm' },
    { type: 'text', text: '已开始出图。' },
  ])
  expect(JSON.stringify(result)).not.toContain('<thinking')
  // 事件序列自洽：每个块都有开始与结束，索引与终帧一致。
  const kinds = events.map(
    (event) => `${event.type}:${'contentIndex' in event ? event.contentIndex : ''}`,
  )
  expect(kinds.filter((kind) => kind.endsWith('_start:0') || kind.endsWith('_end:0'))).toEqual([
    'thinking_start:0',
    'thinking_end:0',
  ])
  expect(kinds).toContain('text_start:1')
  expect(kinds).toContain('text_end:1')
})

it('keeps an unclosed leading tag out of the reply and shifts the tool call index', async () => {
  const { events, result } = await run(() =>
    replyThenToolCall('<thinking>Launching image generation node', {
      id: 'call-1',
      name: 'generateImage',
      args: { prompt: '猫' },
    }),
  )
  expect(textDeltas(events)).toBe('')
  expect(result.content.map((block) => block.type)).toEqual(['thinking', 'toolCall'])
  const toolEvents = events.filter((event) => event.type.startsWith('toolcall_'))
  expect(toolEvents.length).toBeGreaterThan(0)
  for (const event of toolEvents) expect('contentIndex' in event && event.contentIndex).toBe(1)
  const thinkingEnd = events.findIndex((event) => event.type === 'thinking_end')
  const toolStart = events.findIndex((event) => event.type === 'toolcall_start')
  expect(thinkingEnd).toBeGreaterThanOrEqual(0)
  expect(thinkingEnd).toBeLessThan(toolStart)
})

it('leaves tags in the middle of the reply and ordinary replies untouched', async () => {
  const reply = '好的。<thinking>正文里的字</thinking>，后面<think>也在'
  const { events, result } = await run(() =>
    completionStream('好的。<thin', reply.slice('好的。<thin'.length)),
  )
  expect(textDeltas(events)).toBe(reply)
  expect(result.content).toEqual([{ type: 'text', text: reply }])
  const plain = await run(() => completionStream('<', 'b>粗体</b> 回复'))
  expect(textDeltas(plain.events)).toBe('<b>粗体</b> 回复')
  expect(plain.result.content).toEqual([{ type: 'text', text: '<b>粗体</b> 回复' }])
})

it('does nothing for models that are not configured', async () => {
  const raw = '<thinking>x</thinking>y'
  const { events, result } = await run(() => completionStream(raw), 'other-model')
  expect(textDeltas(events)).toBe(raw)
  expect(result.content).toEqual([{ type: 'text', text: raw }])
})

it('rewrites stored messages so replayed native history carries no tags', () => {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: '<thinking>旁白</thinking>回复' },
      { type: 'toolCall', id: 'c', name: 'readCanvas', arguments: {} },
    ],
    api: 'openai-completions',
    provider: 'upstream-gateway',
    model: 'gpt-6-luna',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1,
  }
  expect(rewriteInlineReasoning(message, ['thinking']).content).toEqual([
    { type: 'thinking', thinking: '旁白' },
    { type: 'text', text: '回复' },
    { type: 'toolCall', id: 'c', name: 'readCanvas', arguments: {} },
  ])
})

/** 一条按契约本不该抛、却在给出 `events` 后抛了的上游流。 */
function throwingUpstream(events: AssistantMessageEvent[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
      throw new Error('socket closed')
    },
    result: () => new Promise<AssistantMessage>(() => {}),
  } as unknown as Parameters<typeof withInlineReasoning>[0]
}

const gateway = {
  api: 'openai-completions',
  provider: 'upstream-gateway',
  id: 'gpt-6-luna',
} as const

it('ends the stream with an error frame when the upstream throws mid-stream', async () => {
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: '<thinking>读画布' }],
    api: 'openai-completions',
    provider: 'upstream-gateway',
    model: 'gpt-6-luna',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1,
  }
  const stream = withInlineReasoning(
    throwingUpstream([
      { type: 'start', partial: { ...partial, content: [] } },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: '<thinking>读画布', partial },
    ]),
    ['thinking'],
    gateway,
  )
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  const result = await stream.result()
  expect(events.at(-1)?.type).toBe('error')
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toBe('socket closed')
  expect(result.content).toEqual([{ type: 'thinking', thinking: '读画布' }])
})

it('ends the stream with an empty error frame when the upstream throws before any event', async () => {
  const stream = withInlineReasoning(throwingUpstream([]), ['thinking'], gateway)
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  const result = await stream.result()
  expect(events.map((event) => event.type)).toEqual(['error'])
  expect(result).toMatchObject({
    role: 'assistant',
    content: [],
    model: 'gpt-6-luna',
    stopReason: 'error',
    errorMessage: 'socket closed',
  })
})
