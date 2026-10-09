// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentTurnCost from '../../../../features/agent/components/AgentTurnCost'

const state = vi.hoisted(() => ({
  turn: 'idle',
  historyLoading: false,
  historyFailed: false,
  send: vi.fn(),
}))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state,
  }),
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
const root = createRoot(host)
afterEach(() => {
  act(() => root.render(null))
  state.turn = 'idle'
  state.send.mockClear()
})

it('preserves the stopped turn receipt and continues through the existing send path', () => {
  act(() =>
    root.render(
      <AgentTurnCost footer={{ turnId: 'turn', stopReason: 'aborted', durationMs: 6400 }} />,
    ),
  )
  expect(host.textContent).toContain('已停止')
  expect(host.textContent).toContain('6')
  const button = host.querySelector<HTMLButtonElement>('button')!
  expect(button.textContent).toContain('继续对话')
  act(() => button.click())
  expect(state.send).toHaveBeenCalledExactlyOnceWith('继续')
  state.turn = 'running'
  act(() => root.render(<AgentTurnCost footer={{ turnId: 'turn', stopReason: 'aborted' }} />))
  expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true)
})
