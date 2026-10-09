// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { startupGuardPlugin } from '../../boot/vitePlugin'
import { optionalFontsPlugin } from '../../styles/fontPlugin'

it('loads fonts independently without blocking the application or guide first paint', () => {
  for (const body of ['<div id="boot"></div>', '<main>Guide</main>']) {
    const html = `<html><head></head><body>${body}</body></html>`
    const output = optionalFontsPlugin().transformIndexHtml.handler(html)
    const document = new DOMParser().parseFromString(output, 'text/html')
    const links = [...document.querySelectorAll<HTMLLinkElement>('link')]
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link.rel).toBe('stylesheet')
      expect(link.hasAttribute('data-optional-style')).toBe(true)
      expect(link.media).toBe('print')
      // Loading successfully still activates the font stylesheet.
      Function(link.getAttribute('onload')!).call(link)
      expect(link.media).toBe('all')
    }
  }
  const css = readFileSync(resolve(__dirname, '../../styles/fonts.css'), 'utf8')
  expect(css).not.toContain('@import')
  expect(css).toContain('sans-serif')
})
it('includes optional font links in the final HTML build identity', () => {
  const html = '<html><head></head><body><div id="boot"></div></body></html>'
  const transform = startupGuardPlugin().transformIndexHtml.handler
  const first = transform(optionalFontsPlugin().transformIndexHtml.handler(html))
  const second = transform(html)
  expect(first?.match(/aip-html-build" content="([^"]+)/)?.[1]).not.toBe(
    second?.match(/aip-html-build" content="([^"]+)/)?.[1],
  )
})
