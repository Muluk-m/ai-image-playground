// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentConfirmationGate from '../../../../features/agent/components/AgentConfirmationGate'
import type { ConfirmationHint } from '../../../../features/agent/lib/pendingConfirmations'

const startNodeRun = vi.hoisted(() => vi.fn(() => true))
const confirmAll = vi.hoisted(() =>
  vi.fn(
    (): Promise<{ confirmed: number; failure: { ok: false; reason: string } | null }> =>
      Promise.resolve({ confirmed: 0, failure: null }),
  ),
)

vi.mock('../../../../features/agent/lib/nodeRuns', () => ({
  startAgentNodeRun: startNodeRun,
}))

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: {
    getState: () => ({
      messages: [
        {
          kind: 'tool',
          id: 'nodes',
          canvasRun: { projectId: 'project', nodeIds: ['n1'] },
        },
      ],
      confirmAllPrompts: confirmAll,
    }),
  },
}))

const pending: ConfirmationHint[] = [
  { kind: 'draft', messageId: 'draft-1' },
  { kind: 'batch', messageId: 'batch-card', batchId: 'batch-1' },
]

let host: HTMLDivElement
let root: Root
const jump = vi.fn()
const send = vi.fn()

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  jump.mockClear()
  send.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((one) => one.textContent === label)
}

it('shows the pending count and the three actions', () => {
  act(() =>
    root.render(<AgentConfirmationGate pending={pending} onJump={jump} onSendAnyway={send} />),
  )
  expect(host.textContent).toContain('有 2 张待确认的卡片')
  expect(button('全部确认生成')).toBeTruthy()
  expect(button('跳到卡片')).toBeTruthy()
  expect(button('仍然发送这句话')).toBeTruthy()
})

it('jumps to the first card and can still send the phrase', () => {
  act(() =>
    root.render(<AgentConfirmationGate pending={pending} onJump={jump} onSendAnyway={send} />),
  )
  act(() => button('跳到卡片')!.click())
  act(() => button('仍然发送这句话')!.click())
  expect(jump).toHaveBeenCalledWith('draft-1')
  expect(send).toHaveBeenCalledOnce()
})

it('hides confirm-all when the only pending card is not a generation draft', () => {
  act(() =>
    root.render(
      <AgentConfirmationGate
        pending={[{ kind: 'batch', messageId: 'batch-card', batchId: 'batch-1' }]}
        onJump={jump}
        onSendAnyway={send}
      />,
    ),
  )
  expect(button('全部确认生成')).toBeUndefined()
  expect(button('确认运行节点（1）')).toBeUndefined()
  expect(button('跳到卡片')).toBeTruthy()
})

it('starts a pending node run from its own button and leaves generation drafts alone', () => {
  startNodeRun.mockClear()
  startNodeRun.mockReturnValue(true)
  act(() =>
    root.render(
      <AgentConfirmationGate
        pending={[{ kind: 'nodeRun', messageId: 'nodes' }]}
        onJump={jump}
        onSendAnyway={send}
      />,
    ),
  )
  expect(button('全部确认生成')).toBeUndefined()
  act(() => button('确认运行节点（1）')!.click())
  expect(startNodeRun).toHaveBeenCalledWith('nodes', { projectId: 'project', nodeIds: ['n1'] })
  expect(host.textContent).not.toContain('没能开始')
})

it('says the plan is still being drafted instead of asking to retry card by card', async () => {
  confirmAll.mockResolvedValueOnce({ confirmed: 0, failure: { ok: false, reason: 'drafting' } })
  act(() =>
    root.render(<AgentConfirmationGate pending={pending} onJump={jump} onSendAnyway={send} />),
  )
  await act(async () => button('全部确认生成')!.click())
  const alert = host.querySelector('[role="alert"]')?.textContent
  expect(alert).toBe('助手还在拟这份草稿，拟完再确认。')
  expect(alert).not.toContain('逐张再试')
})
