import { describe, expect, it } from 'bun:test'
import { labelComponents } from '../../../lib/agent/mask-regions'

// segmentation 会读配置；这里只测纯函数，给够启动配置即可，不连数据库。
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused'
process.env.UPSTREAM_BASE_URL ??= 'http://gateway.test'
process.env.UPSTREAM_API_KEY ??= 'fixture-upstream-key'
const { cleanMask, shapeMask } = await import('../../../lib/agent/segmentation')

const W = 400,
  H = 400

function canvas() {
  return new Uint8Array(W * H)
}
function fill(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number, value = 255) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = value
}
const at = (mask: Uint8Array, x: number, y: number) => mask[y * W + x]

describe('labelComponents', () => {
  it('labels 4- or 8-connected parts and records area and border contact', () => {
    // 两个只在对角上相接的方块，外加一个贴边的块。
    const mask = new Uint8Array(6 * 4)
    for (const [x, y] of [
      [1, 1],
      [2, 2],
      [5, 0],
      [5, 1],
    ])
      mask[y! * 6 + x!] = 255
    const four = labelComponents(mask, true, 6, 4, false)
    expect(new Set([...four.labels].filter(Boolean)).size).toBe(3)
    const eight = labelComponents(mask, true, 6, 4, true)
    const labels = new Set([...eight.labels].filter(Boolean))
    expect(labels.size).toBe(2)
    const diagonal = eight.labels[1 * 6 + 1]!
    expect(eight.labels[2 * 6 + 2]).toBe(diagonal)
    expect(eight.areas[diagonal]).toBe(2)
    expect(eight.touchesBorder[diagonal]).toBe(false)
    expect(eight.touchesBorder[eight.labels[5]!]).toBe(true)
    // 反过来数空白：空白是连成一片的。
    expect(
      new Set([...labelComponents(mask, false, 6, 4, false).labels].filter(Boolean)).size,
    ).toBe(1)
  })
})

describe('cleanMask', () => {
  it('closes narrow notches, fills pinholes and drops specks but keeps real holes and parts', () => {
    const mask = canvas()
    fill(mask, 100, 100, 300, 300)
    fill(mask, 200, 280, 204, 300, 0) // 下摆上一道 4px 的缺口
    fill(mask, 150, 150, 155, 155, 0) // 针孔
    fill(mask, 220, 140, 280, 200, 0) // 把手围出来的大洞
    fill(mask, 20, 20, 26, 26) // 碎点
    fill(mask, 330, 330, 370, 370) // 另一只鞋：一块真的部件
    const cleaned = cleanMask(mask, W, H)
    expect(at(cleaned, 202, 295)).toBe(255)
    expect(at(cleaned, 152, 152)).toBe(255)
    expect(at(cleaned, 250, 170)).toBe(0)
    expect(at(cleaned, 22, 22)).toBe(0)
    expect(at(cleaned, 350, 350)).toBe(255)
    // 外轮廓不长不缩：离边几个像素以外和原来一致。
    expect(at(cleaned, 104, 200)).toBe(255)
    expect(at(cleaned, 96, 200)).toBe(0)
  })

  it('smooths a staircase edge into a monotone boundary', () => {
    const mask = canvas()
    // 每 8px 错开 8px 的台阶，像低分辨率蒙版放大后的边。
    for (let y = 100; y < 300; y++) fill(mask, 100, y, 200 + Math.floor((y - 100) / 8) * 8, y + 1)
    const cleaned = cleanMask(mask, W, H)
    const edge = (y: number) => {
      let x = 100
      while (at(cleaned, x, y)) x++
      return x
    }
    for (let y = 120; y < 280; y++) expect(edge(y + 1)).toBeGreaterThanOrEqual(edge(y))
    // 同一级台阶内部不再是一条竖直的墙。
    expect(new Set([edge(160), edge(162), edge(164), edge(166)]).size).toBeGreaterThan(1)
  })

  it('never empties a selection', () => {
    const mask = canvas()
    fill(mask, 10, 10, 12, 12)
    expect(cleanMask(mask, W, H).some((value) => value)).toBe(true)
    expect(cleanMask(canvas(), W, H).some((value) => value)).toBe(false)
  })
})

describe('shapeMask', () => {
  it('cleans at segmenter resolution before scaling up and growing the edge', async () => {
    const data = canvas()
    fill(data, 100, 100, 300, 300)
    fill(data, 200, 280, 203, 300, 0)
    const shaped = await shapeMask({ data, width: W, height: H }, 800, 800, 6)
    const px = (x: number, y: number) => shaped.data[y * 800 + x]
    expect(px(403, 590)).toBe(255)
    expect(px(196, 400)).toBe(255) // 200 − 外扩 6px 内
    expect(px(190, 400)).toBe(0)
  })
})
