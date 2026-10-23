// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentJobProgress, {
  agentJobPhaseLabel,
} from '../../../../features/agent/components/AgentJobProgress'

const billing = vi.hoisted(() => ({ enabled: true, openPricingSheet: vi.fn() }))
vi.mock('../../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled: (name: string) => name === 'billing:credits' && billing.enabled,
}))
vi.mock('../../../../features/pricing/pricingSheetState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../features/pricing/pricingSheetState')>()),
  openPricingSheet: billing.openPricingSheet,
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  billing.enabled = true
  billing.openPricingSheet.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('排队时说清前面还有几张，而不是只说「排队中」（BUG-17）', () => {
  expect(agentJobPhaseLabel({ phase: 'queued', queue: { ahead: 4, limit: 3 } })).toBe(
    '排队中 · 前面还有 4 张',
  )
  expect(agentJobPhaseLabel({ phase: 'queued', queue: { ahead: 0, limit: 3 } })).toBe(
    '排队中 · 下一张就轮到',
  )
  // 服务端没给位置时照旧。
  expect(agentJobPhaseLabel({ phase: 'queued' })).toBe('排队中')
})

it('排队卡片给出套餐并发的原因和升级入口', () => {
  act(() =>
    root.render(<AgentJobProgress progress={{ phase: 'queued', queue: { ahead: 2, limit: 3 } }} />),
  )
  const note = host.querySelector('[data-agent-queue-note]')
  expect(note?.textContent).toContain('当前套餐可同时生成 3 张')
  const upgrade = [...host.querySelectorAll('button')].find((one) => one.textContent === '升级套餐')
  expect(upgrade).toBeDefined()
  act(() => upgrade?.click())
  expect(billing.openPricingSheet).toHaveBeenCalledOnce()
})

it('没有计费的部署不给升级入口；生成中不再显示排队说明', () => {
  billing.enabled = false
  act(() =>
    root.render(<AgentJobProgress progress={{ phase: 'queued', queue: { ahead: 1, limit: 2 } }} />),
  )
  expect(host.querySelector('[data-agent-queue-note]')?.textContent).toContain('2 张')
  expect(host.querySelector('button')).toBeNull()

  act(() => root.render(<AgentJobProgress progress={{ phase: 'generating' }} />))
  expect(host.querySelector('[data-agent-queue-note]')).toBeNull()
})
