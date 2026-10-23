import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { validateCloudCanvas } from '../canvas-cloud'
import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasUndoManager,
  deleteCanvasNode,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '../canvas-document'
import {
  type CanvasResult,
  cacheCanvasResultDisplay,
  canvasInputFingerprint,
  canvasMainResult,
  canvasResultIsStale,
  canvasResults,
  chooseCanvasResult,
  dropCanvasNodeFile,
  dropCanvasResultFile,
  promoteCanvasResultMedia,
  promoteCanvasVideoMedia,
  recordCanvasResult,
  refreshCanvasResultDisplay,
} from '../canvas-results'

const origin = canvasOrigin('user', 'results')
it('marks preset output stale when its preset or supplemental requirement changes', () => {
  const doc = fixture()
  try {
    updateCanvasNode(
      doc,
      'image',
      {
        data: { meta: { nodeImagePreset: 'character-sheet', nodePrompt: 'green coat' } },
      },
      origin,
    )
    const fingerprint = canvasInputFingerprint(doc, 'image')
    updateCanvasNode(
      doc,
      'image',
      {
        data: { meta: { nodeImagePreset: 'character-sheet', nodePrompt: 'blue coat' } },
      },
      origin,
    )
    expect(canvasInputFingerprint(doc, 'image')).not.toBe(fingerprint)
    updateCanvasNode(
      doc,
      'image',
      {
        data: { meta: { nodeImagePreset: '', nodePrompt: 'green coat' } },
      },
      origin,
    )
    expect(canvasInputFingerprint(doc, 'image')).not.toBe(fingerprint)
  } finally {
    doc.destroy()
  }
})
function fixture() {
  const doc = new Y.Doc()
  insertCanvasNode(
    doc,
    {
      id: 'text',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      data: { text: 'A tree', fontSize: 16, fill: '#fff' },
    },
    origin,
  )
  for (const id of ['image', 'downstream'])
    insertCanvasNode(
      doc,
      { id, type: 'image', x: 200, y: 0, width: 100, height: 80, data: {} },
      origin,
    )
  connectCanvasNodes(doc, { source: 'text', target: 'image' }, origin)
  connectCanvasNodes(doc, { source: 'image', target: 'downstream' }, origin)
  return doc
}
function result(doc: Y.Doc, id: string, nodeId = 'image'): CanvasResult {
  return {
    id,
    nodeId,
    kind: 'image',
    source: { type: 'queue', taskId: id, outputIndex: 0 },
    createdAt: 1,
    inputFingerprint: canvasInputFingerprint(doc, nodeId),
  }
}
function choose(doc: Y.Doc, id: string, nodeId = 'image') {
  return chooseCanvasResult(doc, nodeId, id, { data: {} }, origin)
}

describe('canvas result references', () => {
  it('merges independently completed candidates and converges on one main pointer', () => {
    const a = fixture(),
      b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    recordCanvasResult(a, result(a, 'one'), origin)
    recordCanvasResult(b, result(b, 'two'), origin)
    choose(a, 'one')
    choose(b, 'two')
    const au = Y.encodeStateAsUpdate(a),
      bu = Y.encodeStateAsUpdate(b)
    Y.applyUpdate(a, bu)
    Y.applyUpdate(b, au)
    expect(canvasResults(a)).toHaveLength(2)
    expect(canvasResults(a)).toEqual(canvasResults(b))
    expect(canvasMainResult(a, 'image')).toEqual(canvasMainResult(b, 'image'))
    validateCloudCanvas(a, { version: 1, elements: [] })
    a.destroy()
    b.destroy()
  })
  it('undoes the main pointer and displayed media in one step without removing completed candidates', () => {
    const doc = fixture()
    for (const id of ['one', 'two']) recordCanvasResult(doc, result(doc, id), origin)
    choose(doc, 'one')
    const undo = createCanvasUndoManager(doc, origin)
    chooseCanvasResult(doc, 'image', 'two', { data: { fileId: 'two-file' }, width: 320 }, origin)
    expect(canvasMainResult(doc, 'image')?.id).toBe('two')
    undo.undo()
    expect(canvasMainResult(doc, 'image')?.id).toBe('one')
    expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'image')?.width).toBe(100)
    expect(canvasResults(doc)).toHaveLength(2)
    undo.destroy()
    doc.destroy()
  })
  it('marks only direct downstream results stale on content or main-result changes, not layout or names', () => {
    const doc = fixture()
    recordCanvasResult(doc, result(doc, 'one'), origin)
    choose(doc, 'one')
    recordCanvasResult(doc, result(doc, 'child', 'downstream'), origin)
    choose(doc, 'child', 'downstream')
    moveCanvasNodes(doc, [{ id: 'text', x: 500, y: 900 }], origin)
    updateCanvasNode(
      doc,
      'text',
      { data: { text: 'A tree', fontSize: 32, fill: '#000', name: 'title' } },
      origin,
    )
    expect(canvasResultIsStale(doc, 'image')).toBe(false)
    updateCanvasNode(
      doc,
      'text',
      { data: { text: 'A forest', fontSize: 32, fill: '#000' } },
      origin,
    )
    expect(canvasResultIsStale(doc, 'image')).toBe(true)
    expect(canvasResultIsStale(doc, 'downstream')).toBe(false)
    recordCanvasResult(doc, result(doc, 'two'), origin)
    choose(doc, 'two')
    expect(canvasResultIsStale(doc, 'image')).toBe(false)
    expect(canvasResultIsStale(doc, 'downstream')).toBe(true)
    choose(doc, 'one')
    expect(canvasResultIsStale(doc, 'downstream')).toBe(false)
    deleteCanvasNode(doc, 'text', origin)
    expect(canvasResultIsStale(doc, 'image')).toBe(true)
    doc.destroy()
  })
  it('does not resurrect a deleted target when an asynchronous generation completes', () => {
    const doc = fixture(),
      output = result(doc, 'late')
    deleteCanvasNode(doc, 'image', origin)
    expect(recordCanvasResult(doc, output, origin)).toBe(false)
    expect(choose(doc, 'late')).toBe(false)
    expect(canvasResults(doc)).toHaveLength(0)
    doc.destroy()
  })
  it('rejects embedded outputs, local files and cross-node main pointers in cloud updates', () => {
    for (const source of [
      { type: 'queue', taskId: 'q', outputIndex: -1 },
      { type: 'file', fileId: 'local' },
      { type: 'queue', taskId: 'q', outputIndex: 0, bytes: 'data:image/png;base64,a' },
    ]) {
      const doc = fixture()
      doc.getMap('nodeResults').set('invalid', { ...result(doc, 'invalid'), source })
      expect(() => validateCloudCanvas(doc, { version: 1, elements: [] })).toThrow(
        'invalid_canvas_result',
      )
      doc.destroy()
    }
    const doc = fixture()
    doc.getMap('nodeResults').set('bad-kind', { ...result(doc, 'bad-kind'), kind: ['image'] })
    expect(() => validateCloudCanvas(doc, { version: 1, elements: [] })).toThrow(
      'invalid_canvas_result',
    )
    doc.getMap('nodeResults').delete('bad-kind')
    recordCanvasResult(doc, result(doc, 'one'), origin)
    doc.getMap('mainResults').set('downstream', 'one')
    expect(() => validateCloudCanvas(doc, { version: 1, elements: [] })).toThrow(
      'invalid_canvas_result',
    )
    doc.destroy()
  })
  it('keeps the chosen pixels when another device edits a stale copy of node metadata', () => {
    const a = fixture()
    for (const id of ['one', 'two']) recordCanvasResult(a, result(a, id), origin)
    chooseCanvasResult(a, 'image', 'one', { data: { fileId: 'one-file' } }, origin)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    a.clientID = 1
    b.clientID = 2
    chooseCanvasResult(a, 'image', 'two', { data: { fileId: 'two-file' } }, origin)
    updateCanvasNode(
      b,
      'image',
      { data: { fileId: 'one-file', meta: { nodePrompt: 'edited offline' } } },
      origin,
    )
    const au = Y.encodeStateAsUpdate(a),
      bu = Y.encodeStateAsUpdate(b)
    Y.applyUpdate(a, bu)
    Y.applyUpdate(b, au)
    for (const doc of [a, b]) {
      expect(canvasMainResult(doc, 'image')?.id).toBe('two')
      expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'image')?.data).toMatchObject({
        fileId: 'two-file',
        meta: { nodePrompt: 'edited offline' },
      })
      doc.destroy()
    }
  })
  it('does not undo a completed candidate selected on another device', () => {
    const a = fixture(),
      undo = createCanvasUndoManager(a, origin)
    recordCanvasResult(a, result(a, 'one'), origin)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    choose(b, 'one')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    undo.undo()
    expect(canvasMainResult(a, 'image')?.id).toBe('one')
    validateCloudCanvas(a, { version: 1, elements: [] })
    undo.destroy()
    a.destroy()
    b.destroy()
  })
  it('keeps fingerprints stable when an uploaded bitmap becomes durable', () => {
    const doc = fixture()
    updateCanvasNode(doc, 'image', { data: { fileId: 'original-bitmap' } }, origin)
    const before = canvasInputFingerprint(doc, 'downstream')
    promoteCanvasResultMedia(
      doc,
      'image',
      'original-bitmap',
      '11111111-1111-4111-8111-111111111111',
      origin,
    )
    expect(canvasInputFingerprint(doc, 'downstream')).toBe(before)
    doc.destroy()
  })
  it('restores the original bitmap when first selection is promoted then undone', () => {
    const doc = fixture()
    updateCanvasNode(doc, 'image', { data: { fileId: 'original' } }, origin)
    recordCanvasResult(doc, result(doc, 'first'), origin)
    const undo = createCanvasUndoManager(doc, origin)
    chooseCanvasResult(doc, 'image', 'first', { data: { fileId: 'new' } }, origin)
    promoteCanvasResultMedia(
      doc,
      'image',
      'new',
      '11111111-1111-4111-8111-111111111111',
      canvasOrigin('system', 'promotion'),
    )
    undo.undo()
    expect(canvasMainResult(doc, 'image')).toBeUndefined()
    expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'image')?.data).toMatchObject({
      fileId: 'original',
    })
    undo.redo()
    expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'image')?.data).toMatchObject({
      mediaId: '11111111-1111-4111-8111-111111111111',
    })
    undo.destroy()
    doc.destroy()
  })
  it('lets real legacy replacements replace the main result while metadata edits leave it selected', () => {
    const doc = fixture()
    recordCanvasResult(doc, result(doc, 'first'), origin)
    chooseCanvasResult(doc, 'image', 'first', { data: { fileId: 'original' } }, origin)
    const old = {
      id: 'image',
      type: 'image' as const,
      fileId: 'original',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      rotation: 0,
    }
    const named = { ...old, name: 'renamed' }
    synchronizeLegacyElements(doc, [old], [named], origin)
    expect(canvasMainResult(doc, 'image')?.id).toBe('first')
    synchronizeLegacyElements(doc, [named], [{ ...named, fileId: 'cropped' }], origin)
    expect(canvasMainResult(doc, 'image')).toBeUndefined()
    expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'image')?.data).toMatchObject({
      fileId: 'cropped',
    })
    doc.destroy()
  })
  it('derives cloud cache identifiers for media-only main results', () => {
    const doc = fixture(),
      mediaId = '11111111-1111-4111-8111-111111111111'
    recordCanvasResult(doc, result(doc, 'first'), origin)
    chooseCanvasResult(doc, 'image', 'first', { data: { mediaId } }, origin)
    expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'image')?.data).toMatchObject({
      fileId: `cloud-${mediaId}`,
      mediaId,
    })
    validateCloudCanvas(doc, { version: 1, elements: [] })
    doc.destroy()
  })
})

it('retains adopted videos across main selection undo and delayed poster decoding', () => {
  const doc = fixture()
  deleteCanvasNode(doc, 'downstream', origin)
  const mediaId = '11111111-1111-4111-8111-111111111111'
  const one = { taskId: 'old-task', outputIndex: 0 }
  const two = { taskId: 'new-task', outputIndex: 0 }
  for (const [id, video] of [
    ['one', one],
    ['two', two],
  ] as const)
    recordCanvasResult(doc, { ...result(doc, id), kind: 'video', display: { video } }, origin)
  chooseCanvasResult(doc, 'image', 'one', { data: { video: one } }, origin)
  const undo = createCanvasUndoManager(doc, origin)
  chooseCanvasResult(doc, 'image', 'two', { data: { video: two } }, origin)
  promoteCanvasVideoMedia(doc, one, mediaId, canvasOrigin('system', 'promotion'))
  expect(canvasMainResult(doc, 'image')?.id).toBe('two')
  undo.undo()
  expect(canvasMainResult(doc, 'image')?.display?.video?.mediaId).toBe(mediaId)
  // An in-flight decode began before promotion and must not drop the permanent original.
  chooseCanvasResult(doc, 'image', 'one', { data: { video: one } }, origin)
  expect(canvasMainResult(doc, 'image')?.display?.video?.mediaId).toBe(mediaId)
  cacheCanvasResultDisplay(doc, 'one', { video: one }, origin)
  refreshCanvasResultDisplay(doc, 'image', { video: one }, origin)
  expect(canvasMainResult(doc, 'image')?.display?.video?.mediaId).toBe(mediaId)
  expect(canvasMainResult(doc, 'image')?.adopted).toBe(true)
  expect(canvasResults(doc).find((r) => r.id === 'two')?.display?.video?.mediaId).toBeUndefined()
  validateCloudCanvas(doc, { version: 1, elements: [] })
  undo.destroy()
  doc.destroy()
})

it('tracks asset semantic inputs while keeping ordinary image labels cosmetic', () => {
  const doc = fixture()
  connectCanvasNodes(doc, { source: 'image', target: 'downstream' }, origin)
  const original = canvasInputFingerprint(doc, 'downstream')
  updateCanvasNode(doc, 'image', { data: { name: 'cosmetic label' } }, origin)
  expect(canvasInputFingerprint(doc, 'downstream')).toBe(original)
  updateCanvasNode(
    doc,
    'image',
    { data: { name: 'night street', meta: { nodeKind: 'asset', assetDescription: 'neon' } } },
    origin,
  )
  const before = canvasInputFingerprint(doc, 'downstream')
  updateCanvasNode(
    doc,
    'image',
    { data: { name: 'morning street', meta: { nodeKind: 'asset', assetDescription: 'neon' } } },
    origin,
  )
  expect(canvasInputFingerprint(doc, 'downstream')).not.toBe(before)
})

it('round-trips character-sheet provenance and rejects unknown view labels', () => {
  const doc = fixture()
  const image = { ...result(doc, 'sheet'), assetViewLabel: 'sheet' as const }
  doc.getMap('nodeResults').set(image.id, image)
  validateCloudCanvas(doc, { version: 1, elements: [] })
  const restored = new Y.Doc()
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc))
  expect(canvasResults(restored)[0]?.assetViewLabel).toBe('sheet')
  doc.getMap('nodeResults').set(image.id, { ...image, assetViewLabel: 'unknown' })
  expect(() => validateCloudCanvas(doc, { version: 1, elements: [] })).toThrow(
    'invalid_canvas_result',
  )
})

it('binds storyboard output to its reviewed revision without changing ordinary node fingerprints', () => {
  const doc = fixture(),
    ordinary = canvasInputFingerprint(doc, 'image')
  updateCanvasNode(doc, 'image', { data: { meta: { nodePrompt: 'ordinary edit' } } }, origin)
  expect(canvasInputFingerprint(doc, 'image')).toBe(ordinary)
  updateCanvasNode(
    doc,
    'image',
    {
      data: {
        meta: {
          storyboardId: 'board',
          storyboardRole: 'frame',
          storyboardFingerprint: 'revision1',
          nodePrompt: 'shot',
        },
      },
    },
    origin,
  )
  recordCanvasResult(doc, result(doc, 'first-frame'), origin)
  choose(doc, 'first-frame')
  expect(canvasResultIsStale(doc, 'image')).toBe(false)
  updateCanvasNode(
    doc,
    'image',
    {
      data: {
        meta: {
          storyboardId: 'board',
          storyboardRole: 'frame',
          storyboardFingerprint: 'revision2',
          nodePrompt: 'shot',
        },
      },
    },
    origin,
  )
  expect(canvasResultIsStale(doc, 'image')).toBe(true)
})

it('turns a node with an unusable local image into an empty card the server accepts (BUG-10)', () => {
  const doc = new Y.Doc()
  insertCanvasNode(
    doc,
    {
      id: 'zero',
      type: 'image',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      data: {
        fileId: 'zero',
        name: 'zero.png',
        naturalWidth: 1,
        naturalHeight: 1,
        meta: { contentIdentity: 'zero', kept: 'yes' },
      },
    },
    origin,
  )
  insertCanvasNode(
    doc,
    { id: 'other', type: 'image', x: 0, y: 0, width: 50, height: 50, data: { fileId: 'replaced' } },
    origin,
  )
  recordCanvasResult(
    doc,
    {
      id: 'file',
      nodeId: 'zero',
      kind: 'image',
      source: { type: 'file', fileId: 'zero' },
      createdAt: 1,
    },
    origin,
  )
  chooseCanvasResult(doc, 'zero', 'file', { data: { fileId: 'zero' } }, origin)
  expect(() => validateCloudCanvas(doc, { version: 1, elements: [] })).toThrow()
  expect(dropCanvasResultFile(doc, 'zero', origin)).toBe(1)
  expect(dropCanvasNodeFile(doc, 'zero', 'zero', origin)).toBe(true)
  // 期间换了图的节点不动。
  expect(dropCanvasNodeFile(doc, 'other', 'zero', origin)).toBe(false)
  const nodes = readCanvasDocument(doc).nodes
  // 内容身份跟着坏图一起去掉，下游指纹不会再当它还在。
  expect(nodes.find((n) => n.id === 'zero')?.data).toEqual({
    name: 'zero.png',
    meta: { kept: 'yes' },
  })
  expect(nodes.find((n) => n.id === 'other')?.data).toEqual({ fileId: 'replaced' })
  expect(canvasResults(doc)).toEqual([])
  expect(canvasMainResult(doc, 'zero')).toBeUndefined()
  deleteCanvasNode(doc, 'other', origin)
  expect(() => validateCloudCanvas(doc, { version: 1, elements: [] })).not.toThrow()
})
