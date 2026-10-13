import {
  canvasOrigin,
  chooseCanvasResult,
  connectCanvasNodes,
  finishCanvasNodeJob,
  insertCanvasNode,
  recordCanvasResult,
  setCanvasNodeJob,
} from '@image-playground/shared'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { currentNodeBatch, runNodeBatch } from '../../../../features/canvas/lib/nodeBatch'

const mocks = vi.hoisted(() => ({ submit: vi.fn() }))
vi.mock('../../../../features/canvas/lib/nodeCanvasGenerate', () => ({
  submitNodeImage: mocks.submit,
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  getPrivateSubmissionGuard: () => ({ blocked: false }),
}))
vi.mock('../../../../lib/channels/videoChannels', () => ({ videoModelOptions: () => [] }))
afterEach(() => mocks.submit.mockReset())
const origin = canvasOrigin('system', 'batch-test')
function setup() {
  const doc = new Y.Doc(),
    editor = new CanvasEditor(new CanvasDoc())
  for (const id of ['a', 'x', 'b'])
    insertCanvasNode(
      doc,
      {
        id,
        type: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        data: { meta: { nodeKind: 'image', nodePrompt: id } },
      },
      origin,
    )
  connectCanvasNodes(doc, { source: 'a', target: 'b' }, origin)
  const ids = ['a', 'x', 'b'],
    started: string[] = []
  mocks.submit.mockImplementation((_editor, _doc, id) => {
    started.push(id)
    setCanvasNodeJob(
      doc,
      {
        id: `job-${id}`,
        nodeId: id,
        status: 'loading',
        createdAt: Date.now(),
        message: '',
        meta: { prompt: id, clientRequestId: `job-${id}` },
      },
      origin,
    )
    return true
  })
  function complete(id: string, result = `result-${id}`, taskId = `canvas:job-${id}`) {
    editor.doc.files = { ...editor.doc.files, [result]: `data:image/png;base64,${result}` }
    recordCanvasResult(
      doc,
      {
        id: result,
        nodeId: id,
        kind: 'image',
        source: { type: 'local', taskId, outputIndex: 0 },
        createdAt: Date.now(),
      },
      origin,
    )
    chooseCanvasResult(doc, id, result, { data: { fileId: result } }, origin)
    finishCanvasNodeJob(doc, `job-${id}`, origin)
  }
  return { doc, editor, ids, started, complete, plan: currentNodeBatch(doc, editor, ids) }
}
it('waits for each actual Yjs result, then submits its current bitmap to downstream', async () => {
  const t = setup()
  const running = runNodeBatch(
    t.doc,
    t.editor,
    t.ids,
    t.plan,
    new AbortController().signal,
    () => {},
  )
  expect(t.started).toEqual(['a'])
  t.complete('a')
  await vi.waitFor(() => expect(t.started).toEqual(['a', 'x']))
  t.complete('x')
  await vi.waitFor(() => expect(t.started).toEqual(['a', 'x', 'b']))
  expect(mocks.submit.mock.calls[2]?.[4]).toEqual(['data:image/png;base64,result-a'])
  t.complete('b')
  await running
})
it('stops before downstream if a completed dependency changes while another job runs', async () => {
  const t = setup()
  const running = runNodeBatch(
    t.doc,
    t.editor,
    t.ids,
    t.plan,
    new AbortController().signal,
    () => {},
  )
  const rejected = expect(running).rejects.toMatchObject({ code: 'changed' })
  t.complete('a')
  await vi.waitFor(() => expect(t.started).toEqual(['a', 'x']))
  t.complete('a', 'another-result')
  t.complete('x')
  await rejected
  expect(t.started).toEqual(['a', 'x'])
})
it('cancels remaining jobs without cancelling the already submitted task', async () => {
  const t = setup(),
    controller = new AbortController()
  const running = runNodeBatch(t.doc, t.editor, t.ids, t.plan, controller.signal, () => {})
  controller.abort()
  await expect(running).rejects.toMatchObject({ code: 'cancelled' })
  expect(t.started).toEqual(['a'])
  t.complete('a')
  expect(t.started).toEqual(['a'])
})

it('does not adopt a collaborator result created after this batch began', async () => {
  const t = setup()
  const running = runNodeBatch(
    t.doc,
    t.editor,
    t.ids,
    t.plan,
    new AbortController().signal,
    () => {},
  )
  const rejected = expect(running).rejects.toMatchObject({ code: 'changed' })
  t.complete('a', 'other-result', 'canvas:other-request')
  await rejected
  expect(t.started).toEqual(['a'])
})
