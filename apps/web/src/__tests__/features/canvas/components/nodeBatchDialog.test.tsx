// @vitest-environment jsdom
import { canvasOrigin, createCanvasUndoManager, readCanvasDocument } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import NodeBatchDialog from '../../../../features/canvas/components/NodeBatchDialog'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { useStore } from '../../../../store'

const mocks = vi.hoisted(() => ({ current: vi.fn(), run: vi.fn(async () => {}) }))
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
