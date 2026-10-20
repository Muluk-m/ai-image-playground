import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContactPanel } from '../components/ContactModal'
import { MarketingHome } from '../components/MarketingHome'
import {
  CONTACT_EMAIL,
  caseHref,
  libraryRows,
  marketingCopy,
  showcaseCases,
  wallColumns,
  X_URL,
} from '../marketing'

const manifest = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../web/public/inspiration-manifest.json'),
    'utf8',
  ),
) as { items: Array<{ id: string }> }
const ids = new Set(manifest.items.map((item) => item.id))

describe('marketing v4.1', () => {
  it('keeps the approved Chinese copy and routes the calls to action', () => {
    const html = renderToStaticMarkup(
      createElement(MarketingHome, { locale: 'zh-CN', start: () => {} }),
    )
    const text = marketingCopy['zh-CN']
    expect(html).toContain(text.hero.line1)
    expect(html).toContain(text.hero.line2)
    expect(html).toContain(text.hero.note)
    expect(html).toContain('免费开始创作')
    expect(html).toContain('看看能做什么')
    expect(html).toContain('一句提示词')
    expect(html).toContain('从想法到成片')
    expect(html).toContain('不知道写什么？')
    expect(html).toContain('从一句话开始')
    expect(html).toContain('href="/guide/"')
    expect(html).toContain('href="/terms"')
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('href="/explore"')
    expect(html).toContain('href="/explore#inspirations/r26-01"')
    expect(html).toContain('href="/explore#inspirations/r26-10"')
    expect(html).toContain('href="/explore#inspirations/r26-26"')
    expect(html).not.toContain('href="/explore#inspirations/"')
    expect(html).toContain('src="/brand/muvloom-mark.svg"')
    expect(html).toContain('loading="lazy"')
  })

  it('translates the English page without changing the original prompts', () => {
    const html = renderToStaticMarkup(
      createElement(MarketingHome, { locale: 'en', start: () => {} }),
    )
    expect(html).toContain('Muvloom handles the rest')
    expect(html).toContain('Start creating free')
    expect(html).toContain('New accounts get 2,000 credits')
    expect(html).toContain('href="/guide/en/"')
    expect(html).toContain(showcaseCases('en')[1]!.prompt)
    expect(html).not.toContain('免费开始')
  })

  it('links showcase cases only when the inspiration manifest has them', () => {
    const cases = showcaseCases('zh-CN')
    expect(caseHref(null)).toBe('/explore')
    expect(cases[0]?.id).toBeNull()
    for (const item of cases.slice(1)) {
      expect(item.id && ids.has(item.id)).toBe(true)
      expect(caseHref(item.id)).toBe(`/explore#inspirations/${item.id}`)
    }
  })

  it('builds the same wall and closing rows the prototype scrolls', () => {
    const columns = wallColumns()
    expect(columns).toHaveLength(9)
    expect(columns[0]?.length).toBeGreaterThan(10)
    expect(columns[0]?.slice(0, columns[0].length / 2)).toEqual(
      columns[0]?.slice(columns[0].length / 2),
    )
    const rows = libraryRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.some((file) => file.startsWith('g-'))).toBe(false)
    expect(rows[0]?.length).toBe(28)
  })

  it('renders X and email in the contact dialog and leaves WeChat empty', () => {
    const html = renderToStaticMarkup(
      createElement(ContactPanel, { locale: 'zh-CN', onClose: () => {} }),
    )
    expect(html).toContain('联系我们')
    expect(html).toContain(`href="${X_URL}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain(CONTACT_EMAIL)
    expect(html).toContain(`href="mailto:${CONTACT_EMAIL}"`)
    expect(html).toContain('复制')
    expect(html).not.toContain('data-contact-channel="wechat"')
    const withWechat = renderToStaticMarkup(
      createElement(ContactPanel, {
        locale: 'zh-CN',
        onClose: () => {},
        wechat: { qrSrc: '/future-wechat.webp', title: '微信', detail: '扫码' },
      }),
    )
    expect(withWechat).toContain('data-contact-channel="wechat"')
    expect(withWechat).toContain('/future-wechat.webp')
  })
})
