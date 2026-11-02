import { expect, it } from 'bun:test'
import {
  AGENT_LENGTH_CONTINUE_NOTE,
  agentLengthFailureText,
} from '../../../lib/agent/length-continuation'

it('names how many plan items were saved, and stays honest when none were', () => {
  expect(agentLengthFailureText(6)).toBe(
    '这次要生成的内容太多，已保存到第 6 项。可以回复「继续」接着做，或减少张数。',
  )
  expect(agentLengthFailureText(0)).toBe(
    '这次要生成的内容太多，回复没有写完。可以回复「继续」接着做，或减少张数。',
  )
  expect(AGENT_LENGTH_CONTINUE_NOTE).toContain('每次不超过 8 项')
})
