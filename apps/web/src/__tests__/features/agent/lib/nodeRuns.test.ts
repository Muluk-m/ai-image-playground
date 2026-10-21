import { expect, it } from 'vitest'
import {
  isAgentNodeRunOrigin,
  registerAgentNodeRunOrigin,
  releaseIdleAgentNodeRunOrigins,
} from '../../../../features/agent/lib/nodeRuns'

it('drops idle origins when the conversation is cleared and caps the set', () => {
  for (let index = 0; index < 201; index += 1) registerAgentNodeRunOrigin(`origin-cap-${index}`)
  expect(isAgentNodeRunOrigin('origin-cap-0')).toBe(false)
  expect(isAgentNodeRunOrigin('origin-cap-200')).toBe(true)
  releaseIdleAgentNodeRunOrigins()
  expect(isAgentNodeRunOrigin('origin-cap-200')).toBe(false)
})
