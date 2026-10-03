import { beforeEach, expect, it, vi } from 'vitest'

const handoff = vi.hoisted(() => ({ start: vi.fn(async () => true) }))
vi.mock('../../../../features/agent/lib/heroHandoff', () => ({
  startCanvasFromComposer: handoff.start,
}))

const { applyInspiration } = await import('../../../../features/inspiration/lib/applyInspiration')
const { useStore } = await import('../../../../store')

const skillItem = {
  id: 'skill-item',
  kind: 'skill',
  skill: 'look-clean-studio',
  prompt: '用这只马克杯出一张主图',
  referenceImages: [],
} as unknown as Parameters<typeof applyInspiration>[0]

beforeEach(() => {
  handoff.start.mockClear()
  useStore.setState({ prompt: '', inputImages: [] })
})

it.each([
  ['chat', 'chat'],
  ['canvas', 'canvas'],
  ['generate', 'canvas'],
] as const)('技能灵感在「%s」入口下开 %s 项目', async (target, experience) => {
  useStore.getState().setCreateTarget(target)
  applyInspiration(skillItem)
  await vi.waitFor(() => expect(handoff.start).toHaveBeenCalledTimes(1))
  expect(handoff.start).toHaveBeenCalledWith(undefined, experience)
})
