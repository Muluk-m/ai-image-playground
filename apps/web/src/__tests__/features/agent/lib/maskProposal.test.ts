import { describe, expect, it, vi } from 'vitest'
import {
  addClick,
  annotationRegions,
  cardMaskPlacement,
  cardMaskStroke,
  confirmedMaskSource,
  dilateMask,
  editMaskRgba,
  invertInset,
  invertMask,
  maskAnswerReference,
  maskAnswerText,
  maskArea,
  maskOutputCount,
  proposalRegions,
  regionForClick,
} from '../../../../features/agent/lib/maskProposal'
import { paintMaskStroke } from '../../../../features/canvas/lib/inpaintMask'

/** 一个矩形的二值蒙版（测试夹具）。 */
function rect(
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
) {
  const data = new Uint8Array(width * height)
  for (let y = Math.round(box.y * height); y < Math.round((box.y + box.height) * height); y++)
    for (let x = Math.round(box.x * width); x < Math.round((box.x + box.width) * width); x++)
      data[y * width + x] = 1
  return { data, width, height }
}

const WORDS = { confirmed: '按确认的范围修改', keep: '不动：', annotation: '标注', arrow: '箭头' }

describe('范围蒙版', () => {
  it('expands the edge by exactly the radius', () => {
    const single = { data: new Uint8Array(21 * 21), width: 21, height: 21 }
    single.data[10 * 21 + 10] = 1
    const grown = dilateMask(single, 4)
    expect(grown.data[10 * 21 + 14]).toBe(1)
    expect(grown.data[10 * 21 + 15]).toBe(0)
    expect(grown.data[14 * 21 + 10]).toBe(1)
    // 对角方向按圆走：(2,3) 在半径 4 以内，(3,3) 不在。
    expect(grown.data[13 * 21 + 12]).toBe(1)
    expect(grown.data[13 * 21 + 13]).toBe(0)
    expect(dilateMask(single, 0)).toBe(single)
  })

  it('writes the upstream mask format: opaque keeps, transparent edits', () => {
    const mask = rect(4, 2, { x: 0.5, y: 0, width: 0.5, height: 1 })
    const rgba = editMaskRgba(mask)
    expect(rgba[3]).toBe(255)
    expect(rgba[3 * 4 + 3]).toBe(0)
    expect(Array.from(rgba.subarray(12, 15))).toEqual([255, 255, 255])
  })
})

describe('确认那条消息', () => {
  const proposal = {
    imageId: 'image-1',
    mediaId: '00000000-0000-4000-8000-000000000001',
    target: '杯身和把手',
    change: '换成米白色釉面',
    keep: ['桌面', '书'],
  }
  const annotations = [
    {
      id: 7,
      kind: 'arrow' as const,
      from: { x: 0.9, y: 0.1 },
      to: { x: 0.7, y: 0.5 },
      note: '把手内侧也改',
    },
    { id: 9, kind: 'note' as const, at: { x: 0.99, y: 0.99 }, note: '  ' },
  ]

  it('names the range, the change, what stays and each note', () => {
    expect(maskAnswerText(proposal, annotations, WORDS)).toBe(
      '按确认的范围修改「杯身和把手」：换成米白色釉面\n不动：桌面、书\n标注 1（箭头）：把手内侧也改',
    )
  })

  it('keeps notes as numbered regions only and references the stored original by id', () => {
    const regions = annotationRegions(annotations)
    expect(regions[0]).toMatchObject({ number: 1, note: '把手内侧也改', arrow: { x: 0.9, y: 0.1 } })
    expect(regions[0]!.x + regions[0]!.width / 2).toBeCloseTo(0.7)
    // 贴着右下角的标注不越界。
    expect(regions[1]!.x + regions[1]!.width).toBeLessThanOrEqual(1)
    expect(regions[1]!.note).toBeUndefined()
    const reference = maskAnswerReference(proposal, 'data:image/png;base64,AA==', regions)
    expect(reference).toEqual({
      imageId: 'image-1',
      dataUrl: 'aip-media:00000000-0000-4000-8000-000000000001',
      maskDataUrl: 'data:image/png;base64,AA==',
      regions,
      editAction: 'inpaint',
    })
  })
})

describe('card regions and confirmation', () => {
  const box = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }

  it('treats a single-target proposal as region 1 and keeps numbered regions as given', () => {
    expect(proposalRegions({ box, maskMediaId: 'm' })).toEqual([
      { number: 1, box, selected: true, maskMediaId: 'm' },
    ])
    expect(
      proposalRegions({
        box,
        regions: [
          { number: 1, label: '左边的杯子', box, selected: false },
          { number: 2, box: { ...box, x: 0.6 }, selected: true, maskMediaId: 'r2' },
        ],
      }).map((one) => [one.number, one.label, one.selected, one.maskMediaId]),
    ).toEqual([
      [1, '左边的杯子', false, undefined],
      [2, undefined, true, 'r2'],
    ])
  })

  it('sends a click to the region under it, else the smallest box around it, else the active one', () => {
    const regions = [
      { number: 1, box: { x: 0, y: 0, width: 1, height: 1 }, selected: true },
      { number: 2, box: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }, selected: false },
    ]
    expect(regionForClick(regions, [2], { x: 0.1, y: 0.1 }, true, 1)).toBe(2)
    expect(regionForClick(regions, [1, 2], { x: 0.7, y: 0.7 }, true, 1)).toBe(1)
    expect(regionForClick(regions, [], { x: 0.7, y: 0.7 }, true, 1)).toBe(2)
    expect(regionForClick(regions, [], { x: 0.7, y: 0.7 }, false, 1)).toBe(1)
  })

  it('makes two images by default and keeps a larger composer count', () => {
    expect(maskOutputCount(undefined)).toBe(2)
    expect(maskOutputCount(1)).toBe(2)
    expect(maskOutputCount(4)).toBe(4)
  })

  it('reads the confirmed mask back from the answer for the same image only', () => {
    const proposal = { imageId: 'img' }
    expect(confirmedMaskSource([{ imageId: 'img', maskMediaId: 'm1' }], proposal)).toBe(
      'aip-media:m1',
    )
    expect(
      confirmedMaskSource([{ imageId: 'img', maskDataUrl: 'data:image/png;base64,AA' }], proposal),
    ).toBe('data:image/png;base64,AA')
    expect(confirmedMaskSource([{ imageId: 'other', maskMediaId: 'm1' }], proposal)).toBeNull()
    expect(confirmedMaskSource(undefined, proposal)).toBeNull()
  })
})

describe('addClick', () => {
  it('replaces an earlier click at the same spot and keeps at most max', () => {
    const a = { x: 0.9, y: 0.56, include: false }
    const b = { x: 0.905, y: 0.56, include: true }
    expect(addClick([a], b, 12)).toEqual([b])
    const far = { x: 0.2, y: 0.2, include: true }
    expect(addClick([a], far, 12)).toEqual([a, far])
    expect(addClick([a, far], b, 1)).toEqual([b])
  })
})

describe('反选', () => {
  it('selects everything but the subject and eats into its edge', () => {
    const mask = rect(100, 100, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 })
    const inverted = invertMask(mask, 3)
    const at = (x: number, y: number) => inverted.data[y * 100 + x]
    expect(at(10, 10)).toBeTruthy()
    expect(at(41, 50)).toBeTruthy()
    expect(at(45, 50)).toBeFalsy()
    expect(at(50, 50)).toBeFalsy()
    expect(maskArea(inverted)).toBeGreaterThan(100 * 100 - 20 * 20)
    expect(maskArea(inverted)).toBeLessThan(100 * 100 - 12 * 12)
  })

  it('grows the edge band with the image size within bounds', () => {
    expect(invertInset(512, 512)).toBe(12)
    expect(invertInset(1536, 1024)).toBe(18)
    expect(invertInset(4096, 3000)).toBe(24)
  })
})

describe('card brush and eraser reuse the canvas stroke rasterizer', () => {
  function recorder() {
    return {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D & {
      moveTo: ReturnType<typeof vi.fn>
      lineTo: ReturnType<typeof vi.fn>
    }
  }

  it('maps relative card points onto original-size mask pixels', () => {
    // 4K 原图在卡片上显示 640px 宽：屏幕上 24px 的笔刷，原图上是 144px。
    const stroke = cardMaskStroke(
      'brush',
      [
        { x: 0.5, y: 0.5 },
        { x: 0.6, y: 0.25 },
      ],
      24,
      640,
      3840,
      2160,
    )
    expect(stroke.points).toEqual([
      { x: 1920, y: 1080 },
      { x: 2304, y: 540 },
    ])
    expect(stroke.width).toBe(144)
    const ctx = recorder()
    paintMaskStroke(ctx, cardMaskPlacement(3840, 2160), { width: 3840, height: 2160 }, stroke, {
      inverted: true,
      color: '#fff',
    })
    expect(ctx.moveTo).toHaveBeenCalledWith(1920, 1080)
    expect(ctx.lineTo).toHaveBeenCalledWith(2304, 540)
    // 非正方形图上笔宽也不打折：摆放就是原图像素，两轴倍率都是 1。
    expect(ctx.lineWidth).toBe(144)
  })

  it.each([
    { tool: 'brush' as const, operation: 'source-over' },
    { tool: 'eraser' as const, operation: 'destination-out' },
  ])('$tool adds to / removes from the white-is-target card mask', ({ tool, operation }) => {
    const ctx = recorder()
    paintMaskStroke(
      ctx,
      cardMaskPlacement(1248, 1248),
      { width: 1248, height: 1248 },
      cardMaskStroke(tool, [{ x: 0.25, y: 0.75 }], 30, 312, 1248, 1248),
      { inverted: true, color: '#fff' },
    )
    expect(ctx.globalCompositeOperation).toBe(operation)
    // 单点轻触留一个圆点。
    expect(ctx.moveTo).toHaveBeenCalledWith(312, 936)
    expect(ctx.lineTo).toHaveBeenCalledWith(312.01, 936)
    expect(ctx.lineWidth).toBe(120)
  })

  it('never shrinks a stroke below 2 original pixels', () => {
    expect(cardMaskStroke('eraser', [{ x: 0, y: 0 }], 6, 2000, 400, 300).width).toBe(2)
  })
})
