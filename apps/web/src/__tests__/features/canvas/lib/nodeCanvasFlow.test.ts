import type { CanvasEdge, CanvasNode } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  composeNodePrompt,
  flowEdgeIds,
  incomingReferences,
  linkFromDrag,
} from '../../../../features/canvas/lib/nodeCanvasFlow'

const image = (id: string, name?: string): CanvasNode => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  z: 0,
  data: { ...(name ? { name } : {}), fileId: `${id}-file` },
})
const text = (id: string, value: string): CanvasNode => ({
  id,
  type: 'text',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  z: 1,
  data: { text: value, fontSize: 32, fill: '#fff' },
})

describe('dragged wires', () => {
  it('connects the node the wire is dropped on', () => {
    expect(linkFromDrag({ nodeId: 'a', handleType: 'source' }, 'b')).toEqual({
      source: 'a',
      target: 'b',
    })
    expect(linkFromDrag({ nodeId: 'b', handleType: 'target' }, 'a')).toEqual({
      source: 'a',
      target: 'b',
    })
    expect(linkFromDrag({ nodeId: 'a', handleType: 'source' }, 'a')).toBeNull()
    expect(linkFromDrag({ nodeId: 'a', handleType: 'source' }, null)).toBeNull()
  })
})

describe('lit flow', () => {
  const edges = [
    { id: 'e:a', source: 'e', target: 'a' },
    { id: 'a:b', source: 'a', target: 'b' },
    { id: 'b:c', source: 'b', target: 'c' },
    { id: 'b:d', source: 'b', target: 'd' },
    { id: 'a:z', source: 'a', target: 'z' },
    { id: 'x:y', source: 'x', target: 'y' },
  ]

  it('lights the wires before and after the hovered one', () => {
    expect(new Set(flowEdgeIds(edges, 'a:b'))).toEqual(new Set(['e:a', 'a:b', 'b:c', 'b:d']))
    expect(flowEdgeIds(edges, 'missing')).toEqual([])
  })
})

describe('incoming references', () => {
  const nodes = [image('a', '海边'), text('b', '第一幕的风'), image('c')]
  const edges: CanvasEdge[] = [
    { id: 'a:b', source: 'a', target: 'b' },
    { id: 'b:c', source: 'b', target: 'c' },
  ]

  it('uses only the node directly upstream', () => {
    expect(incomingReferences(nodes, edges, 'c').map((ref) => ref.id)).toEqual(['b'])
    expect(incomingReferences(nodes, edges, 'b')).toMatchObject([
      { id: 'a', kind: 'image', fileId: 'a-file', label: '海边' },
    ])
  })

  it('puts upstream text ahead of the prompt and leaves images out of the sentence', () => {
    const refs = incomingReferences([text('b', '第一幕的风'), image('a', '海边')], edges, 'c')
    expect(composeNodePrompt('城市屋顶', refs)).toBe('第一幕的风\n城市屋顶')
    expect(composeNodePrompt('', incomingReferences(nodes, edges, 'b'))).toBe('')
  })
})
