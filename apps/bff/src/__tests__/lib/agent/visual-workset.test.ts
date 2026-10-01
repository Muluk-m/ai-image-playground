import { expect, it } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''
const { createVisualWorkset } = await import('../../../lib/agent/visual-workset')
it('rejects transformed context that drops live visual evidence', async () => {
  const messages: AgentMessage[] = [
    {
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      timestamp: Date.now(),
    },
  ]
  let transformations = 0
  const result = await createVisualWorkset().transform(messages, async () => {
    transformations++
    return []
  })
  expect(result).toEqual(messages)
  expect(transformations).toBe(1)
})
it('still compacts text-only history', async () => {
  let calls = 0
  await createVisualWorkset().transform([], async (messages) => {
    calls++
    return messages
  })
  expect(calls).toBe(1)
})
