import { expect, it } from 'bun:test'
import * as Y from 'yjs'
import { canvasProjectDocument, validateCloudCanvas } from '../canvas-cloud'
import {
  canvasOrigin,
  createCanvasUndoManager,
  importLegacyElements,
  insertCanvasNode,
  readCanvasDocument,
  updateCanvasNode,
} from '../canvas-document'
import {
  addStoryboardShot,
  deleteStoryboardShot,
  readStoryboard,
  reorderStoryboardShots,
  storyboardFingerprint,
  updateStoryboardShot,
} from '../canvas-storyboard'

const origin = canvasOrigin('user', 'storyboard')
const seed = () => {
  const doc = new Y.Doc()
  insertCanvasNode(
    doc,
    { id: 'board', type: 'storyboard', x: 0, y: 0, width: 640, height: 340, data: { shots: [] } },
    origin,
  )
  for (const id of ['a', 'b'])
    addStoryboardShot(
      doc,
      'board',
      { id, description: id, lookIds: [], durationSeconds: 5 },
      origin,
    )
  return doc
}
const shots = (doc: Y.Doc) => readStoryboard(doc.getMap<Y.Map<unknown>>('nodes').get('board')!)
it('merges field edits, reordering, additions and deletion without resurrecting deleted shots', () => {
  const a = seed(),
    b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  updateStoryboardShot(a, 'board', 'a', { description: 'changed scene' }, origin)
  updateStoryboardShot(b, 'board', 'a', { dialogue: 'changed dialogue' }, origin)
  reorderStoryboardShots(b, 'board', ['b', 'a'], origin)
  addStoryboardShot(a, 'board', { id: 'c', description: 'third', lookIds: [] }, origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(shots(a).map((s) => s.id)).toEqual(['b', 'a', 'c'])
  expect(shots(a)[1]).toMatchObject({ description: 'changed scene', dialogue: 'changed dialogue' })
  expect(shots(b)).toEqual(shots(a))
  deleteStoryboardShot(a, 'board', 'a', origin)
  updateStoryboardShot(b, 'board', 'a', { camera: 'wide' }, origin)
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(shots(a).map((s) => s.id)).toEqual(['b', 'c'])
  expect(shots(b)).toEqual(shots(a))
})
it('keeps one undo step per user change and invalidates a finalized table after an edit', () => {
  const doc = seed(),
    undo = createCanvasUndoManager(doc, origin)
  const fingerprint = storyboardFingerprint(shots(doc))
  const node = readCanvasDocument(doc).nodes[0]!
  if (node.type !== 'storyboard') throw new Error('wrong node')
  updateCanvasNode(
    doc,
    'board',
    {
      data: { ...node.data, confirmed: { fingerprint, model: 'fixture', quantity: 2, credits: 4 } },
    },
    origin,
  )
  undo.stopCapturing()
  updateStoryboardShot(doc, 'board', 'a', { durationSeconds: 8 }, origin)
  expect(storyboardFingerprint(shots(doc))).not.toBe(fingerprint)
  undo.undo()
  expect(storyboardFingerprint(shots(doc))).toBe(fingerprint)
})
it('projects and imports storyboard rows and validates hidden deleted row payloads', () => {
  const doc = seed(),
    identity = { version: 1 as const, elements: [] }
  const projected = canvasProjectDocument(doc, identity),
    copy = new Y.Doc()
  importLegacyElements(copy, projected.elements, origin)
  expect(shots(copy)).toEqual(shots(doc))
  validateCloudCanvas(doc, identity)
  const entries = doc.getMap<Y.Map<unknown>>('nodes').get('board')!.get('storyboardShots') as Y.Map<
    Y.Map<unknown>
  >
  entries.get('a')!.set('deleted', true)
  entries.get('a')!.set('durationSeconds', -1)
  expect(() => validateCloudCanvas(doc, identity)).toThrow('invalid_canvas_storyboard')
})

it('applies generic data updates to the live rows and stores a compact confirmation receipt', () => {
  const doc = seed()
  const next = shots(doc)
    .map((shot) => ({ ...shot, dialogue: 'updated' }))
    .reverse()
  updateCanvasNode(doc, 'board', { data: { shots: next } }, origin)
  expect(shots(doc)).toEqual(next)
  expect(
    (doc.getMap<Y.Map<unknown>>('nodes').get('board')!.get('data') as { shots: unknown[] }).shots,
  ).toEqual([])
  const long = next.map((shot) => ({ ...shot, description: 'scene'.repeat(2000) }))
  expect(storyboardFingerprint(long).length).toBeLessThan(64)
  expect(storyboardFingerprint(long)).not.toBe(storyboardFingerprint(next))
  validateCloudCanvas(doc, { version: 1, elements: [] })
})
