import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { GUIDE_CLIP_URLS } from '../../../web/src/features/guide/content/media'
import { guideEntries, pageBlocks } from '../../../web/src/features/guide/model'
import { editions, pageList } from '../catalog'
import { Guide } from '../components/Guide'

const publicFile = (src: string) => resolve(import.meta.dirname, '../../../web/public', `.${src}`)
const clipUrls = new Set<string>(Object.values(GUIDE_CLIP_URLS))

const CLIP_FILES = [
  '01-first-image.mp4',
  '01-first-image.webm',
  '02-reference-image.mp4',
  '02-reference-image.webm',
  '03-generation-settings.mp4',
  '03-generation-settings.webm',
  '04-gpt26-gif.mp4',
  '04-gpt26-gif.webm',
  '05-gpt26-svg.mp4',
  '05-gpt26-svg.webm',
  '06-batch-each.mp4',
  '06-batch-each.webm',
  '07-agent-chat.mp4',
  '07-agent-chat.webm',
  '08-video.mp4',
  '08-video.webm',
  '09-inpaint.mp4',
  '09-inpaint.webm',
  '10-explore-remix.mp4',
  '10-explore-remix.webm',
  '11-toolbox-crop.mp4',
  '11-toolbox-crop.webm',
  'promo-site-zh.mp4',
  'promo-site-zh.webm',
  'remix.mp4',
  'remix.webm',
  'settings.mp4',
  'settings.webm',
] as const

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
      for (const block of pageBlocks(page)) {
        if (block.type !== 'video') continue
        expect(clipUrls.has(block.src), block.src).toBe(true)
        expect(block.src.startsWith('https://cms-r2.deepclick.com/'), block.src).toBe(true)
        expect(block.webm && clipUrls.has(block.webm), block.webm).toBe(true)
        expect(block.poster.startsWith('/guide-assets/'), block.poster).toBe(true)
        expect(existsSync(publicFile(block.poster)), block.poster).toBe(true)
      }
    }
    for (const block of guide.home ?? []) {
      if (block.type !== 'video') continue
      expect(clipUrls.has(block.src), block.src).toBe(true)
      expect(block.webm && clipUrls.has(block.webm), block.webm).toBe(true)
      expect(block.poster.startsWith('/guide-assets/'), block.poster).toBe(true)
      expect(existsSync(publicFile(block.poster)), block.poster).toBe(true)
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
    for (const [, src] of html.matchAll(/<source[^>]+src="([^"]+)"/g))
      expect(clipUrls.has(src!), `${from} ${src}`).toBe(true)
    if (html.includes('<video')) expect(html, from).toContain('preload="none"')
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

it('keeps every guide clip on the CDN map and nowhere else', () => {
  expect(Object.keys(GUIDE_CLIP_URLS).sort()).toEqual([...CLIP_FILES].sort())
  for (const [file, url] of Object.entries(GUIDE_CLIP_URLS)) {
    expect(url.startsWith('https://cms-r2.deepclick.com/'), file).toBe(true)
    expect(url.endsWith(file.slice(file.lastIndexOf('.'))), file).toBe(true)
    expect(url).not.toContain('/guide-assets/')
  }
})
