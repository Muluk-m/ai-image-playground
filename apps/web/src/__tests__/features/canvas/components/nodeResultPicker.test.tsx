// @vitest-environment jsdom

import {
  canvasOrigin,
  chooseCanvasResult,
  createCanvasUndoManager,
  insertCanvasNode,
  recordCanvasResult,
} from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import NodeResultPicker from '../../../../features/canvas/components/NodeResultPicker'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { persistLocalNodeResults } from '../../../../features/canvas/lib/nodeResultPersistence'
import { DEFAULT_PARAMS } from '../../../../types'

const persist = vi.hoisted(() => vi.fn(async () => false))
vi.mock('../../../../store', () => ({
  addCompletedCanvasTask: persist,
  useStore: { getState: () => ({ showToast: vi.fn() }) },
}))
vi.mock('../../../../i18n', async (original) => ({
  ...(await original<typeof import('../../../../i18n')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}))
afterEach(() => {
  document.body.innerHTML = ''
})
it('keeps a storage warning visible until retry succeeds, without changing the result', async () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test'),
    undo = createCanvasUndoManager(doc, origin)
  insertCanvasNode(
    doc,
    { id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 100, data: {} },
    origin,
  )
  recordCanvasResult(
    doc,
    {
      id: 'result',
      nodeId: 'image',
      kind: 'image',
      createdAt: 1,
      source: { type: 'local', taskId: 'job', outputIndex: 0 },
    },
    origin,
  )
  chooseCanvasResult(doc, 'image', 'result', { data: {} }, origin)
  await persistLocalNodeResults(doc, 'image', {
    id: 'job',
    prompt: '',
    params: DEFAULT_PARAMS,
    images: ['original'],
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <NodeResultPicker
        canvas={{ doc, origin, undo, destroy: async () => {} }}
        editor={new CanvasEditor(new CanvasDoc())}
        nodeId="image"
      />,
    ),
  )
  expect(host.querySelector('[role=status]')!.textContent).toContain('nodes.candidateStorageFailed')
  persist.mockResolvedValueOnce(true)
  await act(async () => {
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'nodes.retryCandidateStorage',
    )!
    button.click()
  })
  expect(host.querySelector('[role=status]')).toBeNull()
  expect(doc.getMap('mainResults').get('image')).toBe('result')
  act(() => root.unmount())
  undo.destroy()
  doc.destroy()
})
