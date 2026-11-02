import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { guideEntries, pageBlocks } from '../../../web/src/features/guide/model'
import { editions, pageList } from '../catalog'
import { Guide } from '../components/Guide'

const publicFile = (src: string) => resolve(import.meta.dirname, '../../../web/public', `.${src}`)

it('keeps guide content consistent: unique anchors, valid related links, numbered shots', () => {
  for (const guide of Object.values(editions)) {
    const entries = guideEntries(guide)
    const keys = new Set(entries.map((entry) => entry.key))
    const ids = entries.flatMap((entry) => entry.page.sections.map((section) => section.id))
    expect(new Set(ids).size, guide.lang).toBe(ids.length)
    for (const { page, key } of entries) {
      expect(page.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const related of page.related ?? [])
        expect(keys.has(related), `${key} -> ${related}`).toBe(true)
      for (const section of page.sections)
        for (const block of [...(page.intro ?? []), ...section.blocks])
          if (block.type === 'steps' && block.shot?.marks)
            expect(block.shot.marks.length, `${key} ${block.shot.src}`).toBe(block.items.length)
      for (const block of pageBlocks(page))
        if (block.type === 'video')
          for (const src of [block.src, block.webm, block.poster])
            if (src) expect(existsSync(publicFile(src)), src).toBe(true)
    }
  }
})
it('renders every guide link and anchor, including redirects for old chapter URLs', () => {
  const pages = new Map(
    pageList
      .filter((page) => page.kind === 'guide')
      .map((page) => [page.path, renderToStaticMarkup(createElement(Guide, { page }))]),
  )
  for (const path of ['/guide/', '/guide/en/']) expect(pages.get(path)).toContain('id="chapters"')
  expect(pages.get('/guide/create/settings/')).toContain('<span class="guide-ui">恢复默认</span>')
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
      expect(existsSync(publicFile(src!)), src).toBe(true)
  }
  for (const guide of Object.values(editions))
    for (const [from, moved] of Object.entries(guide.moved)) {
      const target = pages.get(`${guide.root}${moved.to}`)
      expect(target, `${guide.root}${from}`).toBeDefined()
      for (const to of Object.values(moved.anchors ?? {})) {
        const [path, anchor] = to.split('#')
        const html = pages.get(`${guide.root}${path}`)
        expect(html, `${from} -> ${to}`).toBeDefined()
        if (anchor) expect(html, `${from} -> ${to}`).toContain(`id="${anchor}"`)
      }
    }
})
