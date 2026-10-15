import { expect, it } from 'bun:test'
import * as Y from 'yjs'
import { canvasProjectDocument, validateCloudCanvas } from '../canvas-cloud'
import {
  canvasOrigin,
  createCanvasUndoManager,
  importLegacyElements,
  readCanvasDocument,
} from '../canvas-document'
import {
  canvasText,
  initializeCanvasTexts,
  plainCanvasText,
  replaceCanvasText,
} from '../canvas-text'

const legacy = {
  version: 1 as const,
  elements: [
    {
      id: 'script',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 300,
      height: 210,
      text: '第一幕\n旧内容\n',
      fill: '#fff',
      fontSize: 16,
    },
  ],
}
const origin = canvasOrigin('user', 'writer')
it('preserves old plain text exactly and initializes only once', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  initializeCanvasTexts(doc)
  const before = Y.encodeStateAsUpdate(doc)
  expect(initializeCanvasTexts(doc)).toBe(false)
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  expect(canvasProjectDocument(doc, legacy).elements[0]).toEqual(legacy.elements[0])
})
it('merges disconnected character edits and formatting; undo removes only local edits', () => {
  const source = new Y.Doc()
  importLegacyElements(source, legacy.elements, origin)
  initializeCanvasTexts(source)
  const a = new Y.Doc(),
    b = new Y.Doc()
  Y.applyUpdate(a, Y.encodeStateAsUpdate(source))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(source))
  const undo = createCanvasUndoManager(a, origin)
  a.transact(() => canvasText(a, 'script')!.insert(0, '新'), origin)
  b.transact(() => {
    canvasText(b, 'script')!.insert(7, '远端')
    canvasText(b, 'script')!.format(3, 1, { header: 1 })
  })
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  expect(readCanvasDocument(a)).toEqual(readCanvasDocument(b))
  expect(canvasText(a, 'script')!.toString()).toContain('远端')
  expect(
    canvasText(a, 'script')!
      .toDelta()
      .some((op: { attributes?: { header?: number } }) => op.attributes?.header === 1),
  ).toBe(true)
  validateCloudCanvas(a, legacy)
  undo.undo()
  expect(canvasText(a, 'script')!.toString().startsWith('新')).toBe(false)
  expect(canvasText(a, 'script')!.toString()).toContain('远端')
  expect(
    canvasText(a, 'script')!
      .toDelta()
      .some((op: { attributes?: { header?: number } }) => op.attributes?.header === 1),
  ).toBe(true)
})
it('rejects unknown rich text formats and embedded network content', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  initializeCanvasTexts(doc)
  canvasText(doc, 'script')!.insertEmbed(0, { image: 'https://example.com/x.png' })
  expect(() => validateCloudCanvas(doc, legacy)).toThrow()
  canvasText(doc, 'script')!.delete(0, 1)
  canvasText(doc, 'script')!.format(0, 1, { link: 'javascript:alert(1)' })
  expect(() => validateCloudCanvas(doc, legacy)).toThrow()
})

it('keeps text offsets aligned across divider embeds for plain-text callers', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  const text = canvasText(doc, 'script')!
  text.delete(0, text.length)
  text.applyDelta([{ insert: 'ab' }, { insert: { divider: true } }, { insert: 'cd\n' }])
  expect(plainCanvasText(text)).toBe('ab\ncd')
  replaceCanvasText(text, 'ab\nXd')
  expect(plainCanvasText(text)).toBe('ab\nXd')
  expect(text.toDelta()).toContainEqual({ insert: { divider: true } })
  replaceCanvasText(text, 'before ab\nXd')
  expect(plainCanvasText(text)).toBe('before ab\nXd')
  replaceCanvasText(text, 'before abXd')
  expect(plainCanvasText(text)).toBe('before abXd')
})
it('rejects a malformed compatibility delta even without a Y.Text field', () => {
  const doc = new Y.Doc()
  importLegacyElements(doc, legacy.elements, origin)
  const node = doc.getMap<Y.Map<unknown>>('nodes').get('script')!
  node.delete('richText')
  node.set('data', { text: 'bad', fontSize: 16, fill: '#fff', richText: {} })
  expect(() => validateCloudCanvas(doc, legacy)).toThrow()
})

it('replaces emoji without splitting UTF-16 surrogate pairs', () => {
  const doc = new Y.Doc()
  const text = doc.getText('text')
  text.insert(0, '😀 tail\n')
  replaceCanvasText(text, '😁 tail')
  expect(plainCanvasText(text)).toBe('😁 tail')
  replaceCanvasText(text, '𐀀 tail')
  expect(plainCanvasText(text)).toBe('𐀀 tail')
  replaceCanvasText(text, '𐐀 tail')
  expect(plainCanvasText(text)).toBe('𐐀 tail')
})
