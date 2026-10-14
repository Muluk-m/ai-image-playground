import { afterEach, expect, it } from 'bun:test'
import { completionStream } from '../../helpers/agentStubs'

process.env.DATABASE_URL = 'postgres://unused/model-output'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'gpt-6-luna'
// 线上遗留值不能把已核实模型重新压回 8K。
process.env.AGENT_CHAT_MAX_TOKENS = '8000'
process.env.OPERATOR_CONFIG_FILE = ''
const { config } = await import('../../../config')
const { agentModel, agentStreamFn, setAgentFetchForTesting } = await import(
  '../../../lib/agent/model'
)
const { agentThinking } = await import('../../../lib/agent/thinking')
const { compactionBudget } = await import('../../../lib/agent/compaction')
const { compactionSettings } = await import('../../../lib/agent/compaction-settings')
afterEach(() => setAgentFetchForTesting())

it('sends each registered model ceiling through the SDK and retains output beyond the old 8K cap', async () => {
  const answer = '完整输出。'.repeat(9000)
  for (const depth of ['fast', 'medium', 'deep', undefined] as const) {
    const model = agentModel(depth)
    let payload: Record<string, unknown> | undefined
    setAgentFetchForTesting(async (_input, init) => {
      payload = JSON.parse(String(init?.body))
      return completionStream(answer)
    })
    const stream = await agentStreamFn(depth)(model, {
      messages: [{ role: 'user', content: '继续完整输出', timestamp: 1 }],
    })
    const result = await stream.result()
    expect(payload?.model).toBe(model.id)
    expect(payload?.max_tokens).toBe(128_000)
    expect(result.stopReason).toBe('stop')
    expect(result.content).toEqual([{ type: 'text', text: answer }])
  }
})

it('reserves the entire output budget even with the old production 8K reserve', () => {
  for (const depth of ['fast', 'medium', 'deep', undefined] as const) {
    const settings = compactionSettings(agentModel(depth), {
      ...config.operator.quotas,
      'agent:compaction-output-reserve-tokens': 8000,
      'agent:compaction-buffer-tokens': 8000,
    })
    expect(compactionBudget(settings)).toEqual({ effectiveWindow: 872_000, threshold: 864_000 })
  }
})

it('keeps explicit legacy fallback only for unregistered custom models', () => {
  const previous = config.agent
  try {
    config.agent = { ...previous, model: 'custom-model', contextWindow: 64000, maxTokens: 16000 }
    expect(agentThinking()).toEqual({
      model: 'custom-model',
      effort: 'off',
      contextWindow: 64000,
      maxTokens: 16000,
    })
  } finally {
    config.agent = previous
  }
})
