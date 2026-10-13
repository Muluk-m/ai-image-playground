import {
  canvasOrigin,
  connectCanvasNodes,
  createCanvasGroup,
  createCanvasUndoManager,
  importLegacyElements,
  readCanvasDocument,
  readCanvasGroups,
  reconcileLegacyElements,
  renderScriptDocument,
  scriptBriefById,
} from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  changeNodeText,
  copyNodes,
  createNode,
  nodeKind,
  pasteNodes,
  removeNodes,
} from '../../../../features/canvas/lib/nodeCanvasActions'
import type { NodeCanvasDocument } from '../../../../features/canvas/lib/nodeCanvasDocument'

function setup(): NodeCanvasDocument {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  const undo = createCanvasUndoManager(doc, origin)
  return {
    doc,
    origin,
    undo,
    async destroy() {
      undo.destroy()
      doc.destroy()
    },
  }
}
describe('node canvas editing transactions', () => {
  it('aligns different-sized siblings on either side and avoids occupied slots without moving existing nodes', () => {
    const canvas = setup()
    const parentId = createNode(canvas, 'image', { x: 0, y: 0 }, '#fff')
    const parent = readCanvasDocument(canvas.doc).nodes[0]!
    const rightId = createNode(canvas, 'text', { x: 0, y: 0 }, '#fff', {
      nodes: [parent],
      side: 'right',
    })
    const leftId = createNode(canvas, 'video', { x: 0, y: 0 }, '#fff', {
      nodes: [parent],
      side: 'left',
    })
    const branchId = createNode(canvas, 'image', { x: 0, y: 0 }, '#fff', {
      nodes: [parent],
      side: 'right',
    })
    const nodes = readCanvasDocument(canvas.doc).nodes
    const right = nodes.find((n) => n.id === rightId)!
    const left = nodes.find((n) => n.id === leftId)!
    const branch = nodes.find((n) => n.id === branchId)!
    expect(right.x - (parent.x + parent.width)).toBe(168)
    expect(parent.x - (left.x + left.width)).toBe(168)
    expect(right.y).toBe(parent.y)
    expect(left.y).toBe(parent.y)
    expect(branch.x).toBe(right.x)
    expect(branch.y).toBe(right.y + right.height + 168)
    expect(nodes.find((n) => n.id === parentId)).toEqual(parent)
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).not.toContain(branchId)
  })
  it('writes a popular brief into one undoable text node', () => {
    const canvas = setup()
    const brief = scriptBriefById('sprout-window')!
    const id = createNode(canvas, 'text', { x: 40, y: 40 }, '#fff', undefined, {
      name: brief.title,
      text: renderScriptDocument(brief),
    })
    const node = readCanvasDocument(canvas.doc).nodes.find((one) => one.id === id)
    expect(node?.type).toBe('text')
    if (node?.type === 'text') {
      expect(node.data.name).toBe('窗台萌芽')
      expect(node.data.text).toContain('## 大纲')
      expect(node.data.text).toContain('## 人物表')
      expect(node.data.text).toContain('林夏')
      expect(node.data.text).toContain('## 第 1 集')
      expect(node.data.text).toContain('第一片新叶')
    }
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes).toEqual([])
  })
  it('undoes creation and inline editing without a second editor history', () => {
    const canvas = setup()
    const id = createNode(canvas, 'text', { x: 0, y: 0 }, '#fff')
    changeNodeText(canvas, id, 'A scene')
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes[0]?.data).toMatchObject({ text: '' })
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(0)
    canvas.undo.redo()
    canvas.undo.redo()
    expect(readCanvasDocument(canvas.doc).nodes[0]?.data).toMatchObject({ text: 'A scene' })
  })
  it('copies a connected selection with new identities and preserves only internal links', () => {
    const canvas = setup()
    const a = createNode(canvas, 'text', { x: 0, y: 0 }, '#fff'),
      b = createNode(canvas, 'image', { x: 500, y: 0 }, '#fff'),
      c = createNode(canvas, 'video', { x: 1000, y: 0 }, '#fff')
    connectCanvasNodes(canvas.doc, { source: a, target: b }, canvas.origin)
    connectCanvasNodes(canvas.doc, { source: b, target: c }, canvas.origin)
    const ids = pasteNodes(canvas, copyNodes(readCanvasDocument(canvas.doc), [a, b]), {
      x: 50,
      y: 500,
    })
    expect(ids).toHaveLength(2)
    expect(ids).not.toContain(a)
    expect(readCanvasDocument(canvas.doc).edges).toContainEqual(
      expect.objectContaining({ source: ids[0], target: ids[1] }),
    )
    expect(readCanvasDocument(canvas.doc).edges).toHaveLength(3)
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(3)
    expect(nodeKind(readCanvasDocument(canvas.doc).nodes[2]!)).toBe('video')
  })
  it('does not resurrect a deleted legacy node on reopen, and undo restores its links', () => {
    const canvas = setup()
    const legacy = [
      {
        id: 'old',
        type: 'text' as const,
        x: 0,
        y: 0,
        width: 300,
        height: 220,
        text: 'old',
        fontSize: 16,
        fill: '#fff',
      },
    ]
    importLegacyElements(canvas.doc, legacy, canvasOrigin('system', 'import'))
    const next = createNode(canvas, 'image', { x: 500, y: 0 }, '#fff')
    connectCanvasNodes(canvas.doc, { source: 'old', target: next }, canvas.origin)
    removeNodes(canvas, ['old'])
    reconcileLegacyElements(canvas.doc, legacy, canvasOrigin('system', 'reopen'))
    expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toEqual([next])
    canvas.undo.undo()
    expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toContain('old')
    expect(readCanvasDocument(canvas.doc).edges).toHaveLength(1)
  })
  it('does not revive an undone new node from its later legacy bitmap', () => {
    const canvas = setup()
    const id = createNode(canvas, 'image', { x: 0, y: 0 }, '#fff')
    canvas.undo.undo()
    reconcileLegacyElements(
      canvas.doc,
      [{ id, type: 'image', x: 0, y: 0, width: 100, height: 100, rotation: 0, fileId: 'bitmap' }],
      canvasOrigin('system', 'reopen'),
    )
    expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(0)
    canvas.undo.redo()
    expect(readCanvasDocument(canvas.doc).nodes[0]?.id).toBe(id)
  })
})

it('copies a group with fresh member identities and disbands without deleting cards', () => {
  const canvas = setup()
  const a = createNode(canvas, 'text', { x: 0, y: 0 }, '#fff'),
    b = createNode(canvas, 'image', { x: 500, y: 0 }, '#fff')
  connectCanvasNodes(canvas.doc, { source: a, target: b }, canvas.origin)
  createCanvasGroup(canvas.doc, 'scene', [a, b], '海边', canvas.origin)
  const ids = pasteNodes(canvas, copyNodes(readCanvasDocument(canvas.doc), ['scene']), {
    x: 0,
    y: 500,
  })
  const groups = readCanvasGroups(canvas.doc)
  expect(groups).toHaveLength(2)
  expect(groups[1]?.members).toEqual(ids.slice(1).sort())
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(2)
  removeNodes(canvas, ['scene'])
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(4)
  expect(readCanvasGroups(canvas.doc)).toHaveLength(1)
  canvas.undo.undo()
  expect(readCanvasGroups(canvas.doc)).toHaveLength(2)
})

it('duplicates an empty group frame and undoes only that copy', () => {
  const canvas = setup()
  createCanvasGroup(canvas.doc, 'empty', [], '空场景', canvas.origin, {
    x: 50,
    y: 70,
    width: 600,
    height: 400,
  })
  const ids = pasteNodes(canvas, copyNodes(readCanvasDocument(canvas.doc), ['empty']), {
    x: 800,
    y: 300,
  })
  expect(ids).toHaveLength(1)
  expect(readCanvasGroups(canvas.doc)[1]).toMatchObject({
    name: '空场景',
    x: 800,
    y: 300,
    width: 600,
    height: 400,
    members: [],
  })
  canvas.undo.undo()
  expect(readCanvasGroups(canvas.doc)).toHaveLength(1)
})

it('remaps copied timeline clips to copied shots while keeping unselected and missing source references', () => {
  const canvas = setup()
  const source = createNode(canvas, 'video', { x: 0, y: 0 }, '#fff')
  const timeline = createNode(canvas, 'timeline', { x: 600, y: 0 }, '#fff')
  connectCanvasNodes(canvas.doc, { source, target: timeline }, canvas.origin)
  const copy = copyNodes(readCanvasDocument(canvas.doc), [source, timeline])
  const timelineCopy = copy.nodes.find((n) => n.type === 'timeline')!
  if (timelineCopy.type !== 'timeline') throw new Error('timeline')
  timelineCopy.data.clips.push({ elementId: 'missing', in: 2, out: 5 })
  const ids = pasteNodes(canvas, copy, { x: 0, y: 400 })
  const created = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === ids[1])!
  expect(created.data).toMatchObject({
    clips: [
      { elementId: ids[0], in: 0 },
      { elementId: 'missing', in: 2, out: 5 },
    ],
  })
})

it('reconnects an independently duplicated timeline to the original shots', () => {
  const canvas = setup()
  const source = createNode(canvas, 'video', { x: 0, y: 0 }, '#fff')
  const timeline = createNode(canvas, 'timeline', { x: 600, y: 0 }, '#fff')
  connectCanvasNodes(canvas.doc, { source, target: timeline }, canvas.origin)
  const [copy] = pasteNodes(canvas, copyNodes(readCanvasDocument(canvas.doc), [timeline]), {
    x: 600,
    y: 500,
  })
  expect(readCanvasDocument(canvas.doc).edges).toContainEqual(
    expect.objectContaining({ source, target: copy }),
  )
})
