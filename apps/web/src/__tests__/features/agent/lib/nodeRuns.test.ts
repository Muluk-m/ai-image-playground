import { expect, it } from 'vitest'
import {
  isAgentNodeRunOrigin,
  registerAgentNodeRunOrigin,
  releaseIdleAgentNodeRunOrigins,
} from '../../../../features/agent/lib/nodeRuns'

it('keeps unconfirmed origins until the conversation state has been cleared', () => {
  for (let index = 0; index < 201; index += 1) registerAgentNodeRunOrigin(`origin-cap-${index}`)
  expect(isAgentNodeRunOrigin('origin-cap-0')).toBe(true)
  expect(isAgentNodeRunOrigin('origin-cap-200')).toBe(true)
  releaseIdleAgentNodeRunOrigins()
  expect(isAgentNodeRunOrigin('origin-cap-0')).toBe(false)
  expect(isAgentNodeRunOrigin('origin-cap-200')).toBe(false)
})
