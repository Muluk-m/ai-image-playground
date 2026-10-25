import { afterEach, expect, it } from 'bun:test'

process.env.DATABASE_URL = 'postgres://unused/model-tool-arguments'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.OPERATOR_CONFIG_FILE = ''
const { agentModel, agentStreamFn, setAgentFetchForTesting } = await import(
  '../../../lib/agent/model'
)
afterEach(() => setAgentFetchForTesting())

const encoder = new TextEncoder()
const event = (delta: object, finish_reason: string | null = null) =>
  encoder.encode(
    `data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
  )

/** 不重复的长文本：真实的长参数每一段都不同，不会被当成退化循环。 */
const varied = (length: number, unit = (i: number) => `shot-${i} `) => {
  let text = ''
  for (let i = 0; text.length < length; i++) text += unit(i)
  return text.slice(0, length)
}

function upstream(
  argumentsText: string,
  step: number,
  hang = false,
  done = '[DONE]',
  delta = (piece: string): object => ({
    tool_calls: [{ index: 0, function: { arguments: piece } }],
  }),
) {
  const seen = { cancelled: false, calls: 0 }
  setAgentFetchForTesting(async () => {
    seen.calls += 1
    let offset = -1
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === -1) {
            offset = 0
            controller.enqueue(
              event({
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'runNodes' } },
                ],
              }),
            )
          } else if (offset < argumentsText.length) {
            controller.enqueue(event(delta(argumentsText.slice(offset, offset + step))))
            offset += step
          } else if (!hang) {
            controller.enqueue(event({}, 'tool_calls'))
            controller.enqueue(encoder.encode(`data: ${done}\n\n`))
            controller.close()
          }
        },
        cancel() {
          seen.cancelled = true
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })
  return seen
}

async function consume() {
  const stream = await agentStreamFn('fast')(agentModel('fast'), {
    messages: [{ role: 'user', content: 'fixture', timestamp: 1 }],
  })
  let argumentDeltas = 0
  for await (const update of stream) {
    if (update.type === 'toolcall_delta' && update.delta) argumentDeltas += 1
  }
  return { result: await stream.result(), argumentDeltas }
}

it('does not reparse every incomplete tool argument delta in the real SDK', async () => {
  const args = { nodeIds: ['a', 'b'], text: varied(16_000, (i) => `雨${i}\\"[{}]`) }
  upstream(JSON.stringify(args), 4)
  const { result, argumentDeltas } = await consume()
  expect(result.stopReason).toBe('toolUse')
  expect(result.content).toEqual([
    { type: 'toolCall', id: 'call_1', name: 'runNodes', arguments: args },
  ])
  expect(argumentDeltas).toBe(1)
}, 10_000)

it('rejects nested arguments below the character cap before the SDK can stall', async () => {
  const seen = upstream('['.repeat(24_000), 8, true)
  const { result } = await consume()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('nesting')
  expect(seen.cancelled).toBe(true)
  expect(seen.calls).toBe(1)
}, 5_000)

it('retains long valid arguments with the current 128K model output budget', async () => {
  const args = { text: varied(96_000) }
  upstream(JSON.stringify(args), 8)
  const { result, argumentDeltas } = await consume()
  expect(result.stopReason).toBe('toolUse')
  expect(result.content).toEqual([
    { type: 'toolCall', id: 'call_1', name: 'runNodes', arguments: args },
  ])
  expect(argumentDeltas).toBe(1)
}, 5_000)

it('ends runaway arguments at the model budget the way an enforced max_tokens would', async () => {
  const seen = upstream(varied(agentModel('fast').maxTokens * 6), 1024, true)
  const { result } = await consume()
  expect(result.stopReason).toBe('length')
  expect(seen.cancelled).toBe(true)
  expect(seen.calls).toBe(1)
}, 10_000)

it('ends runaway text at the model budget', async () => {
  const seen = upstream(
    varied(agentModel('fast').maxTokens * 6),
    1024,
    true,
    '[DONE]',
    (piece) => ({
      content: piece,
    }),
  )
  const { result } = await consume()
  expect(result.stopReason).toBe('length')
  expect(seen.cancelled).toBe(true)
}, 10_000)

it('fails a model call whose output degenerates into a loop', async () => {
  const seen = upstream('林雨捡起蓝色小册子。'.repeat(2_000), 16, true, '[DONE]', (piece) => ({
    content: piece,
  }))
  const { result } = await consume()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('loop')
  expect(seen.cancelled).toBe(true)
  expect(seen.calls).toBe(1)
}, 5_000)

it('flushes arguments before a DONE marker with trailing whitespace accepted by the SDK', async () => {
  upstream('{"nodeIds":["a"]}', 2, false, '[DONE] ')
  const { result } = await consume()
  expect(result.stopReason).toBe('toolUse')
  expect(result.content).toEqual([
    { type: 'toolCall', id: 'call_1', name: 'runNodes', arguments: { nodeIds: ['a'] } },
  ])
})
