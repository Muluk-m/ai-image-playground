import { describe, expect, it } from 'bun:test'
import { AGENT_CANVAS_SNAPSHOT_MAX, parseAgentCanvasSnapshot } from '../agent-canvas-snapshot'

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
    expect(parsed?.omitted).toBe(2)
  })

  it('keeps a video id only when it is an artifact id', () => {
    const base = { type: 'image', x: 0, y: 0, width: 10, height: 10 }
    const kept = parseAgentCanvasSnapshot({
      elements: [{ ...base, id: 'clip', videoId: 'agent_task-1_0' }],
    })
    expect(kept?.elements[0]).toMatchObject({ video: true, videoId: 'agent_task-1_0' })
    const dropped = parseAgentCanvasSnapshot({
      elements: [{ ...base, id: 'cover', video: true, videoId: 'not-a-video' }],
    })
    expect(dropped?.elements[0]).toMatchObject({ video: true })
    expect(dropped?.elements[0]).not.toHaveProperty('videoId')
  })

  it('keeps an empty directory and ignores a payload that is not one', () => {
    expect(parseAgentCanvasSnapshot({ elements: [] })).toEqual({ elements: [] })
    expect(parseAgentCanvasSnapshot(null)).toBeUndefined()
  })

  it('keeps a browser-reported truncation and rejects an oversized input array', () => {
    const image = { id: 'a', type: 'image', x: 0, y: 0, width: 10, height: 10 }
    expect(parseAgentCanvasSnapshot({ elements: [image], omitted: 7 })?.omitted).toBe(7)
    expect(
      parseAgentCanvasSnapshot({
        elements: Array.from({ length: AGENT_CANVAS_SNAPSHOT_MAX + 1 }, () => image),
      }),
    ).toBeUndefined()
  })
})

it('preserves an empty node selection and sanitizes selected node and group ids', () => {
  expect(parseAgentCanvasSnapshot({ elements: [], selectedNodeIds: [] })).toEqual({
    elements: [],
    selectedNodeIds: [],
  })
  expect(
    parseAgentCanvasSnapshot({ elements: [], selectedNodeIds: ['group', 'node', 'node', '', 4] })
      ?.selectedNodeIds,
  ).toEqual(['group', 'node'])
})
