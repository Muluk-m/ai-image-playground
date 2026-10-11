// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ICON_SIZE_PX, ICONS, Icon, type IconName } from '../../../../components/ui/icon'

const svgOf = (markup: string) => {
  const host = document.createElement('div')
  host.innerHTML = markup
  const svg = host.querySelector('svg')
  if (!svg) throw new Error(`no svg in ${markup}`)
  return svg
}

describe('Icon', () => {
  it.each(Object.entries(ICON_SIZE_PX))('renders the %s step at %ipx', (size, px) => {
    const svg = svgOf(
      renderToStaticMarkup(<Icon name="close" size={size as keyof typeof ICON_SIZE_PX} />),
    )
    expect(svg.getAttribute('width')).toBe(String(px))
    expect(svg.getAttribute('height')).toBe(String(px))
  })

  it('draws a 1.5px stroke in screen pixels whatever size CSS gives it', () => {
    const svg = svgOf(renderToStaticMarkup(<Icon name="close" size="xs" />))
    // 线宽按屏幕像素算（non-scaling-stroke），Button 用 CSS 改图标尺寸也不会变粗变细。
    expect(svg.getAttribute('class')).toContain('[&_*]:[vector-effect:non-scaling-stroke]')
  })

  it('defaults to the 16px step and hides decoration from screen readers', () => {
    const svg = svgOf(renderToStaticMarkup(<Icon name="close" />))
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBeNull()
  })

  it('becomes a labelled image when given a label', () => {
    const svg = svgOf(renderToStaticMarkup(<Icon name="close" label="关闭" />))
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('关闭')
    expect(svg.getAttribute('aria-hidden')).toBeNull()
  })

  it('switches to the duotone glyph only for a selected state', () => {
    const line = svgOf(renderToStaticMarkup(<Icon name="favorite" />)).innerHTML
    const solid = svgOf(renderToStaticMarkup(<Icon name="favorite" filled />)).innerHTML
    expect(solid).not.toBe(line)
    // 没有双色款的图形（取自 lucide 的几个）选中时保持描线。
    expect(svgOf(renderToStaticMarkup(<Icon name="pan" filled />)).innerHTML).toBe(
      svgOf(renderToStaticMarkup(<Icon name="pan" />)).innerHTML,
    )
  })

  it('passes className through for colour and motion', () => {
    const svg = svgOf(renderToStaticMarkup(<Icon name="loading" className="animate-spin" />))
    expect(svg.getAttribute('class')).toContain('animate-spin')
  })

  it('draws every registered glyph on the 24 grid in currentColor with 1.5 strokes', () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      for (const filled of [false, true]) {
        const svg = svgOf(renderToStaticMarkup(<Icon name={name} size="lg" filled={filled} />))
        expect(svg.getAttribute('viewBox'), name).toBe('0 0 24 24')
        expect(svg.innerHTML, name).toContain('currentColor')
        expect(svg.innerHTML, name).not.toMatch(/#[0-9a-f]{3,6}\b/i)
        const widths = new Set(
          [...svg.innerHTML.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => m[1]),
        )
        expect(
          [...widths].filter((w) => w !== '1.5'),
          name,
        ).toEqual([])
      }
    }
  })

  it('lists every registered name in docs/design-system/icons.md', () => {
    // 文档里那张语义名表是给人和 Agent 查的，登记新名字时要一起补上（vitest 在 apps/web 下跑）。
    const doc = readFileSync(resolve(process.cwd(), 'docs/design-system/icons.md'), 'utf8')
    const missing = Object.keys(ICONS).filter((name) => !doc.includes(`\`${name}\``))
    expect(missing).toEqual([])
  })
})
