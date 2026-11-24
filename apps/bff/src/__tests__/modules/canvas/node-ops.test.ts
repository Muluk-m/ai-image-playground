import { describe, expect, it } from 'bun:test'
import { readCanvasDocument } from '@image-playground/shared'
import * as Y from 'yjs'
import { CanvasValidationError } from '../../../modules/canvas/errors'
import {
  arrangeCanvasNodes,
  connectCanvasNodeEdges,
  deleteCanvasNodes,
  insertCanvasNodes,
  missingNodeMessage,
  patchCanvasNode,
} from '../../../modules/canvas/node-ops'
import {
  applyCanvasScriptPlan,
  selectRunnableStageNodes,
} from '../../../modules/canvas/storyboard-ops'

describe('modules/canvas pure node & storyboard operations', () => {
  it('inserts, patches, connects, arranges, and deletes nodes while raising CanvasValidationError on invalid mutations', () => {
    const doc = new Y.Doc()
    try {
      insertCanvasNodes(
        doc,
        [
          { id: 'script-1', type: 'text', name: '剧本', text: '第一集：雨夜' },
          { id: 'img-1', type: 'image', name: '主角', prompt: '电影感人像' },
        ],
        new Map(),
        'agent:test',
      )

      const inserted = readCanvasDocument(doc)
      expect(inserted.nodes.map((node) => node.id)).toEqual(['script-1', 'img-1'])

      patchCanvasNode(doc, { id: 'img-1', prompt: '更新后的提示词' }, 'agent:test')
      const patched = readCanvasDocument(doc).nodes.find((node) => node.id === 'img-1')
      expect(patched?.type).toBe('image')
      if (patched?.type === 'image') {
        expect(patched.data.meta?.nodePrompt).toBe('更新后的提示词')
      }

      connectCanvasNodeEdges(doc, [{ source: 'script-1', target: 'img-1' }], 'agent:test')
      expect(
        readCanvasDocument(doc).edges.map(({ source, target }) => ({ source, target })),
      ).toEqual([{ source: 'script-1', target: 'img-1' }])

      arrangeCanvasNodes(doc, ['script-1', 'img-1'], 2, 'agent:test')

      expect(() => patchCanvasNode(doc, { id: 'img-2', prompt: 'x' }, 'agent:test')).toThrow(
        CanvasValidationError,
      )
      expect(missingNodeMessage('img-2', readCanvasDocument(doc).nodes)).toContain('img-1（主角）')

      const runnable = selectRunnableStageNodes(readCanvasDocument(doc), ['img-1'])
      expect(runnable.map((node) => node.id)).toEqual(['img-1'])

      deleteCanvasNodes(doc, ['img-1'], 'agent:test')
      expect(readCanvasDocument(doc).nodes.map((node) => node.id)).toEqual(['script-1'])
    } finally {
      doc.destroy()
    }
  })

  it('applies script plan creating storyboard, assets, and edges atomically', () => {
    const doc = new Y.Doc()
    try {
      insertCanvasNodes(
        doc,
        [{ id: 'script-1', type: 'text', name: '剧本', text: '第1集 街头相遇' }],
        new Map(),
        'agent:test',
      )
      applyCanvasScriptPlan(
        doc,
        {
          scriptNodeId: 'script-1',
          storyboardId: 'sb-ep1',
          episodeNumber: 1,
          assets: [
            { id: 'char-a', kind: 'person', name: '林晚', description: '黑发风衣' },
            { id: 'loc-a', kind: 'location', name: '旧车站', description: '雨夜站台' },
          ],
          shots: [
            {
              id: 'shot-1',
              description: '林晚站在旧车站雨中回望',
              lookIds: ['char-a'],
              locationId: 'loc-a',
            },
          ],
        },
        'agent:test',
      )

      const graph = readCanvasDocument(doc)
      const board = graph.nodes.find((node) => node.id === 'sb-ep1')
      expect(board?.type).toBe('storyboard')
      if (board?.type === 'storyboard') {
        expect(board.data.shots).toHaveLength(1)
        expect(board.data.episode).toEqual({ scriptNodeId: 'script-1', number: 1 })
      }
      expect(graph.edges.map(({ source, target }) => ({ source, target }))).toEqual(
        expect.arrayContaining([
          { source: 'char-a', target: 'sb-ep1' },
          { source: 'loc-a', target: 'sb-ep1' },
          { source: 'script-1', target: 'sb-ep1' },
        ]),
      )
    } finally {
      doc.destroy()
    }
  })
})
