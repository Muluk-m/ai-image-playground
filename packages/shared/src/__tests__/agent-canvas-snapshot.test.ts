import { describe, expect, it } from 'bun:test'
import { parseAgentCanvasSnapshot } from '../agent-canvas-snapshot'

describe('parseAgentCanvasSnapshot', () => {
  it('keeps the images the user can see and drops a broken entry', () => {
    const parsed = parseAgentCanvasSnapshot({
      elements: [
        { id: 'el-a', type: 'image', x: 1, y: 2, width: 10, height: 20, name: '原图' },
        { id: 'el-b', type: 'text', x: 0, y: 0, width: 8, height: 4, text: '页签' },
        { id: '', type: 'image', x: 0, y: 0, width: 1, height: 1 },
        { id: 'el-a', type: 'image', x: 9, y: 9, width: 1, height: 1 },
      ],
    })

    expect(parsed?.elements.map((element) => element.id)).toEqual(['el-a', 'el-b'])
    expect(parsed?.elements[0]).toMatchObject({ type: 'image', name: '原图' })
  })

  it('treats a payload that is not a directory as absent', () => {
    expect(parseAgentCanvasSnapshot({ elements: [] })).toBeUndefined()
    expect(parseAgentCanvasSnapshot(null)).toBeUndefined()
  })
})
