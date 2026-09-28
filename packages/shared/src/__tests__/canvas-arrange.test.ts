import { describe, expect, it } from 'bun:test'
import {
  type ArrangeBox,
  arrangeCaptionHeight,
  arrangeSectionHeight,
  layoutCanvasArrange,
} from '../canvas-arrange'

const note: ArrangeBox = { id: 'note', x: 0, y: 0, w: 80, h: 20 }
const first: ArrangeBox = { id: 'a', x: 400, y: 100, w: 200, h: 150 }
const second: ArrangeBox = { id: 'b', x: 700, y: 300, w: 200, h: 150 }

describe('layoutCanvasArrange', () => {
  it('packs a labelled group to the right of everything it did not touch', () => {
    const [han, zhong] = layoutCanvasArrange(
      [
        {
          label: '古装角色',
          columns: 1,
          items: [{ elementId: 'a', caption: '韩湘子' }, { elementId: 'b' }],
        },
      ],
      [note, first, second],
    )

    expect(han).toMatchObject({
      elementId: 'a',
      x: note.x + note.w + 160,
      y: first.y + arrangeSectionHeight() + arrangeCaptionHeight(),
      caption: '韩湘子',
      section: '古装角色',
    })
    expect(zhong).toMatchObject({
      elementId: 'b',
      x: han!.x,
      y: han!.y + first.h + 96 + arrangeCaptionHeight(),
      section: '',
    })
    expect(zhong!.caption).toBeUndefined()
    expect([han, zhong].map((item) => item?.elementId)).not.toContain('note')
  })

  it('keeps a board that is entirely selected near its own top-left', () => {
    const [only] = layoutCanvasArrange([{ items: [{ elementId: 'a', caption: '   ' }] }], [first])

    expect(only).toMatchObject({
      elementId: 'a',
      x: first.x,
      y: first.y + arrangeCaptionHeight(),
      section: '',
    })
    expect(only!.caption).toBeUndefined()
  })

  it('reads a square group left to right, then down', () => {
    const boxes = ['a', 'b', 'c', 'd'].map((id, index) => ({
      id,
      x: index * 10,
      y: 40,
      w: 100,
      h: 80,
    }))
    const placed = layoutCanvasArrange(
      [{ items: boxes.map((box) => ({ elementId: box.id })) }],
      boxes,
    )

    expect(placed.map((item) => item.elementId)).toEqual(['a', 'b', 'c', 'd'])
    expect(placed[1]!.y).toBe(placed[0]!.y)
    expect(placed[1]!.x).toBeGreaterThan(placed[0]!.x)
    expect(placed[2]!.x).toBe(placed[0]!.x)
    expect(placed[2]!.y).toBeGreaterThan(placed[0]!.y)
  })

  it('drops a repeated id and cuts a caption down to one line', () => {
    const placed = layoutCanvasArrange(
      [
        {
          items: [
            { elementId: 'a', caption: '字'.repeat(30) },
            { elementId: 'a', caption: '第二次' },
          ],
        },
      ],
      [first],
    )

    expect(placed).toHaveLength(1)
    expect(placed[0]!.caption).toHaveLength(24)
  })
})
