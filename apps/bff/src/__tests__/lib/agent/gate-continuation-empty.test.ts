import { expect, it } from 'bun:test'
import {
  GATE_CONTINUATION_EMPTY_REPLY,
  shouldFillEmptyGateContinuation,
} from '../../../lib/agent/gate-continuation-empty'

it('fills only an empty, successful gate continuation', () => {
  expect(
    shouldFillEmptyGateContinuation({
      continuation: true,
      error: false,
      aborted: false,
      storedAny: false,
      openText: false,
    }),
  ).toBe(true)
  expect(GATE_CONTINUATION_EMPTY_REPLY).toContain('已提交生成')
})

it('does not fill when the continuation already wrote something', () => {
  expect(
    shouldFillEmptyGateContinuation({
      continuation: true,
      error: false,
      aborted: false,
      storedAny: true,
      openText: false,
    }),
  ).toBe(false)
  expect(
    shouldFillEmptyGateContinuation({
      continuation: true,
      error: false,
      aborted: false,
      storedAny: false,
      openText: true,
    }),
  ).toBe(false)
})

it('does not fill an empty ordinary user turn', () => {
  expect(
    shouldFillEmptyGateContinuation({
      continuation: false,
      error: false,
      aborted: false,
      storedAny: false,
      openText: false,
    }),
  ).toBe(false)
})
