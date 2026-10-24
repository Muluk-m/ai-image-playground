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

function upstream(argumentsText: string, step: number, hang = false) {
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
            controller.enqueue(
              event({
                tool_calls: [
                  { index: 0, function: { arguments: argumentsText.slice(offset, offset + step) } },
                ],
              }),
            )
            offset += step
          } else if (!hang) {
            controller.enqueue(event({}, 'tool_calls'))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
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
  const args = { nodeIds: ['a', 'b'], text: '雨\\"[{}]'.repeat(2000) }
  upstream(JSON.stringify(args), 4)
  const { result, argumentDeltas } = await consume()
  expect(result.stopReason).toBe('toolUse')
  expect(result.content).toEqual([
    { type: 'toolCall', id: 'call_1', name: 'runNodes', arguments: args },
  ])
  expect(argumentDeltas).toBe(1)
}, 10_000)

it('rejects nested arguments below the character cap before the SDK can stall', async () => {
  const seen = upstream('['.repeat(2000), 8)
  const { result } = await consume()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('nesting')
  expect(seen.cancelled).toBe(true)
  expect(seen.calls).toBe(1)
}, 5_000)
