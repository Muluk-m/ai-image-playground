// @vitest-environment jsdom
import { canvasOrigin, createCanvasUndoManager, readCanvasDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import NodeBatchDialog from '../../../../features/canvas/components/NodeBatchDialog'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import type * as ApiProfiles from '../../../../lib/apiProfiles'
import type * as PublicChannels from '../../../../lib/channels/publicChannels'
import { useStore } from '../../../../store'

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  run: vi.fn(async () => {}),
  tiers: ['1K', '2K', '4K'],
}))
vi.mock('../../../../lib/gptPremium', () => ({
  useGptPremiumLocked: () => ({ member: false, settled: false }),
}))
vi.mock('../../../../lib/apiProfiles', async (original) => {
  const actual = await original<typeof ApiProfiles>()
  return {
    ...actual,
    clientProfileToApiProfile: (...args: Parameters<typeof actual.clientProfileToApiProfile>) => ({
      ...actual.clientProfileToApiProfile(...args),
      model: 'gemini-nano-banana-2.1',
    }),
  }
})
vi.mock('../../../../lib/channels/publicChannels', async (original) => ({
  ...(await original<typeof PublicChannels>()),
  getPublicChannels: () => [
    { models: [{ id: 'gemini-nano-banana-2.1', imageSizes: mocks.tiers }] },
  ],
}))
vi.mock('../../../../features/canvas/lib/nodeBatch', async (original) => ({
  ...(await original<typeof import('../../../../features/canvas/lib/nodeBatch')>()),
  currentNodeBatch: mocks.current,
  runNodeBatch: mocks.run,
}))
it('cancels without submitting and requires reviewing changed quantities before executing', async () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test'),
    undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => {} },
    editor = new CanvasEditor(new CanvasDoc())
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host),
    close = vi.fn()
  let plan = {
    signature: 'old',
    jobs: [{ id: 'a', kind: 'image', label: '芽芽', model: 'fixture', quantity: 2 }],
    settings: useStore.getState().settings,
    params: useStore.getState().params,
  }
  mocks.current.mockImplementation(() => plan)
  const render = () =>
    root.render(
      <NodeBatchDialog
        canvas={canvas}
        editor={editor}
        ids={['a']}
        snapshot={{
          ...readCanvasDocument(doc),
          nodes: [{ id: 'a', type: 'image', z: 0, x: 0, y: 0, width: 100, height: 100, data: {} }],
        }}
        onClose={close}
      />,
    )
  const button = (text: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
  await act(async () => render())
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('2 张')
  await act(async () => button('取消').click())
  expect(close).toHaveBeenCalledOnce()
  expect(mocks.run).not.toHaveBeenCalled()
  plan = { ...plan, signature: 'new', jobs: [{ ...plan.jobs[0]!, quantity: 3 }] }
  await act(async () => render())
  expect(document.querySelector('[role=alert]')).not.toBeNull()
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === '确认并执行')).toBe(
    false,
  )
  await act(async () => button('重新预估').click())
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('3 张')
  await act(async () => button('确认并执行').click())
  expect(mocks.run).toHaveBeenCalledOnce()
  await act(async () => root.unmount())
  host.remove()
  undo.destroy()
  doc.destroy()
})

it.each([
  { tier: '1K' as const, kind: 'image', open4K: true, blocked: false },
  { tier: '2K' as const, kind: 'image', open4K: true, blocked: false },
  { tier: '4K' as const, kind: 'video', open4K: true, blocked: false },
  { tier: '4K' as const, kind: 'image', open4K: false, blocked: false },
  { tier: '4K' as const, kind: 'image', open4K: true, blocked: true },
])('waits for membership only when it changes the effective quote: %j', async ({
  tier,
  kind,
  open4K,
  blocked,
}) => {
  const savedParams = useStore.getState().params
  // Persisted drafts can carry tiers that the current editor does not expose.
  const params = JSON.parse(JSON.stringify({ ...savedParams, gemini_image_size: tier }))
  useStore.setState({ params })
  mocks.tiers = open4K ? ['1K', '2K', '4K'] : ['1K', '2K']
  mocks.run.mockClear()
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'membership-failure')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => {} }
  const editor = new CanvasEditor(new CanvasDoc())
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mocks.current.mockReturnValue({
    signature: 'stable',
    jobs: [{ id: 'a', kind, label: '芽芽', model: 'gemini-nano-banana-2.1', quantity: 1 }],
    settings: useStore.getState().settings,
    params: useStore.getState().params,
  })
  try {
    await act(async () =>
      root.render(
        <NodeBatchDialog
          canvas={canvas}
          editor={editor}
          ids={['a']}
          snapshot={{
            ...readCanvasDocument(doc),
            nodes: [
              { id: 'a', type: 'image', z: 0, x: 0, y: 0, width: 100, height: 100, data: {} },
            ],
          }}
          onClose={() => {}}
        />,
      ),
    )
    const confirm = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '确认并执行',
    )!
    expect(confirm.disabled).toBe(blocked)
    await act(async () => confirm.click())
    expect(mocks.run).toHaveBeenCalledTimes(blocked ? 0 : 1)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    undo.destroy()
    doc.destroy()
    useStore.setState({ params: savedParams })
    mocks.tiers = ['1K', '2K', '4K']
  }
})
