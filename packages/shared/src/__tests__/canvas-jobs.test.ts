import { expect, it } from 'bun:test'
import * as Y from 'yjs'
import { validateCloudCanvas } from '../canvas-cloud'
import { canvasOrigin, insertCanvasNode, readCanvasDocument } from '../canvas-document'
import { canvasNodeJobs, finishCanvasNodeJob, setCanvasNodeJob } from '../canvas-jobs'

it('merges fan-out acceptances and preserves unfinished jobs after another job completes', () => {
  const origin = canvasOrigin('system', 'job-test'),
    a = new Y.Doc(),
    b = new Y.Doc()
  insertCanvasNode(
    a,
    { id: 'node', type: 'image', x: 0, y: 0, width: 300, height: 200, data: {} },
    origin,
  )
  for (const id of ['one', 'two'])
    setCanvasNodeJob(
      a,
      {
        id,
        nodeId: 'node',
        createdAt: 1,
        status: 'loading',
        message: '',
        meta: { nodeGeneration: true, prompt: 'A', clientRequestId: id },
      },
      origin,
    )
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const one = canvasNodeJobs(a)[0]!,
    two = canvasNodeJobs(b)[1]!
  setCanvasNodeJob(a, { ...one, meta: { ...one.meta, bffRequestId: 'accepted-one' } }, origin)
  setCanvasNodeJob(b, { ...two, meta: { ...two.meta, bffRequestId: 'accepted-two' } }, origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(canvasNodeJobs(a).map((job) => job.meta.bffRequestId)).toEqual([
    'accepted-one',
    'accepted-two',
  ])
  finishCanvasNodeJob(a, 'one', origin)
  expect(readCanvasDocument(a).nodes[0]!.data).toMatchObject({
    pending: { meta: { bffRequestId: 'accepted-two' } },
  })
  finishCanvasNodeJob(a, 'two', origin)
  expect(readCanvasDocument(a).nodes[0]!.data).not.toHaveProperty('pending')
  validateCloudCanvas(a, { version: 1, elements: [] })
  a.destroy()
  b.destroy()
})

it('rejects malformed recovery metadata before accepting a cloud update', () => {
  const doc = new Y.Doc(),
    origin = canvasOrigin('system', 'test')
  insertCanvasNode(
    doc,
    { id: 'node', type: 'image', x: 0, y: 0, width: 300, height: 200, data: {} },
    origin,
  )
  const valid = {
    id: 'job',
    nodeId: 'node',
    createdAt: 1,
    status: 'loading',
    message: '',
    meta: { nodeGeneration: true, prompt: 'test', clientRequestId: 'job' },
  }
  doc.getMap('nodeJobs').set('job', { ...valid, meta: { ...valid.meta, assetViewLabel: 'sheet' } })
  validateCloudCanvas(doc, { version: 1, elements: [] })
  for (const meta of [
    { ...valid.meta, nodeVideo: true },
    { ...valid.meta, params: [] },
    { ...valid.meta, generation: { duration: -1 } },
    { ...valid.meta, extra: 'unknown' },
    { ...valid.meta, assetViewLabel: 'unknown' },
    { prompt: 'test', clientRequestId: 'job', nodeVideo: true, assetViewLabel: 'sheet' },
  ]) {
    doc.getMap('nodeJobs').set('job', { ...valid, meta })
    expect(() => validateCloudCanvas(doc, { version: 1, elements: [] })).toThrow(
      'invalid_canvas_job',
    )
  }
  doc.destroy()
})
