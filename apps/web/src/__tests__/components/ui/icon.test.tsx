// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ICON_SIZE_PX, ICONS, Icon, type IconName } from '../../../components/ui/icon'

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

  it('keeps the same 1.5px visual stroke at every size', () => {
    for (const px of Object.values(ICON_SIZE_PX)) {
      const size = Object.entries(ICON_SIZE_PX).find(([, value]) => value === px)?.[0]
      const svg = svgOf(
        renderToStaticMarkup(<Icon name="close" size={size as keyof typeof ICON_SIZE_PX} />),
      )
      // lucide 在 24 的 viewBox 里画；绝对线宽 = 1.5 × 24 / 渲染尺寸。
      expect(Number(svg.getAttribute('stroke-width'))).toBeCloseTo((1.5 * 24) / px, 3)
    }
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

  it('fills the glyph only for a selected state', () => {
    expect(svgOf(renderToStaticMarkup(<Icon name="favorite" />)).getAttribute('fill')).toBe('none')
    expect(svgOf(renderToStaticMarkup(<Icon name="favorite" filled />)).getAttribute('fill')).toBe(
      'currentColor',
    )
  })

  it('passes className through for colour and motion', () => {
    const svg = svgOf(renderToStaticMarkup(<Icon name="loading" className="animate-spin" />))
    expect(svg.getAttribute('class')).toContain('animate-spin')
  })

  it('renders every registered icon with the shared stroke settings', () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const svg = svgOf(renderToStaticMarkup(<Icon name={name} size="lg" />))
      expect(svg.getAttribute('viewBox'), name).toBe('0 0 24 24')
      expect(svg.getAttribute('stroke-linecap'), name).toBe('round')
      expect(Number(svg.getAttribute('stroke-width')), name).toBeCloseTo(1.5, 3)
    }
  })
})
