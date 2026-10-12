import type { CanvasEdge, CanvasNode } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  composeNodePrompt,
  incomingReferences,
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
