import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { editions, pageList } from '../catalog'
import { Guide } from '../components/Guide'

it('keeps both guide editions structurally aligned', () => {
  const shape = (guide: typeof editions.en) =>
    guide.chapters.map((chapter) => ({
      id: chapter.id,
      faq: chapter.faq?.length,
      sections: chapter.subsections.map((section) => ({
        id: section.id,
        blocks: section.blocks.map((block) => block.type),
      })),
    }))
  expect(shape(editions.en)).toEqual(shape(editions['zh-CN']))
})
it('renders every old guide link and anchor without requiring JavaScript', () => {
  const pages = new Map(
    pageList
      .filter((page) => page.kind === 'guide')
      .map((page) => [page.path, renderToStaticMarkup(createElement(Guide, { page }))]),
  )
  for (const path of ['/guide/', '/guide/en/']) expect(pages.get(path)).toContain('id="chapters"')
  expect(pages.get('/guide/create/')).toContain(
    '<strong><span class="guide-ui">智能比例 Auto</span></strong>',
  )
  for (const [from, html] of pages) {
    expect(html).toContain('<h1>')
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (!href!.startsWith('/guide/') && !href!.startsWith('#')) continue
      const [path, anchor] = href!.split('#'),
        target = pages.get(path || from)
      expect(target, `${from} -> ${href}`).toBeDefined()
      if (anchor) expect(target, `${from} -> ${href}`).toContain(`id="${anchor}"`)
    }
    for (const [, src] of html.matchAll(/<img[^>]+src="([^"]+)"/g))
      expect(existsSync(resolve(import.meta.dirname, '../../../web/public', `.${src}`)), src).toBe(
        true,
      )
  }
})
