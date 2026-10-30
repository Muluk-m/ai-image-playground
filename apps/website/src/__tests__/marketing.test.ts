import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContactPanel } from '../components/ContactModal'
import { MarketingHome } from '../components/MarketingHome'
import {
  CONTACT_EMAIL,
  caseHref,
  featureCards,
  marketingCopy,
  showcaseCases,
  starterPrompts,
} from '../marketing'

const manifest = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../web/public/inspiration-manifest.json'),
    'utf8',
  ),
) as { items: Array<{ id: string; prompt: string }> }
const ids = new Set(manifest.items.map((item) => item.id))

const PUBLIC = resolve(import.meta.dirname, '../../../web/public')
const prompts = new Map(manifest.items.map((item) => [item.id, item.prompt]))

describe('marketing home', () => {
  it('renders the approved Chinese copy and routes the calls to action', () => {
    const html = renderToStaticMarkup(
      createElement(MarketingHome, { locale: 'zh-CN', start: () => {} }),
    )
    const text = marketingCopy['zh-CN']
    expect(html).toContain('说出画面，幕芽成片')
    expect(html).toContain(text.hero.note)
    expect(html).toContain('开始创作')
    expect(html).toContain('真实案例')
    expect(html).toContain('从想法到成片')
    expect(html).toContain('从一句话开始')
    expect(html).toContain('进入幕芽')
    expect(html).toContain('href="/guide/"')
    expect(html).toContain('href="/terms"')
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('href="/explore"')
    for (const item of showcaseCases('zh-CN')) {
      expect(html).toContain(`href="/explore#inspirations/${item.id}"`)
    }
    expect(html).toContain('src="/brand/muvloom-mark.svg"')
    expect(html).toContain('loading="lazy"')
  })

  it('never promises sign-up credits and keeps exactly one solid primary button', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(MarketingHome, { locale, start: () => {} }))
      expect(html).not.toMatch(/积分|credits/i)
      expect(html.match(/bg-primary text-primary-foreground/g)).toHaveLength(1)
      // 官网接不住参考图交接，不放一个只会弹登录框的上传入口。
      expect(html).not.toMatch(/添加参考图|reference image/i)
    }
  })

  it('links the pricing page from the top nav and the footer', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(MarketingHome, { locale, start: () => {} }))
      const link = `<a href="/pricing">${marketingCopy[locale].nav.pricing}</a>`
      expect(html.indexOf(link)).toBeLessThan(html.indexOf('<header'))
      expect(html.lastIndexOf(link)).toBeGreaterThan(html.indexOf('<footer'))
      // 窄屏收起中间导航后，右侧还留着一个「定价」。
      const nav = html.slice(html.indexOf('class="mkt-nav"'), html.indexOf('<header'))
      expect(nav).toContain(
        `<a class="mkt-nav-pricing" href="/pricing">${marketingCopy[locale].nav.pricing}</a>`,
      )
    }
  })

  it('gives the footer a #contact anchor', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(MarketingHome, { locale, start: () => {} }))
      expect(html).toContain('href="#contact"')
      expect(html.indexOf('id="contact"')).toBeGreaterThan(html.indexOf('<footer'))
    }
  })

  it('translates the English page', () => {
    const html = renderToStaticMarkup(
      createElement(MarketingHome, { locale: 'en', start: () => {} }),
    )
    expect(html).toContain('Describe it. Muvloom makes it.')
    expect(html).toContain('Start creating')
    expect(html).toContain('href="/guide/en/"')
    expect(html).not.toContain('开始创作')
  })

  it('uses only bundled images from the inspiration manifest', () => {
    const images = [
      ...showcaseCases('zh-CN').map((item) => item.image),
      ...starterPrompts('zh-CN').map((item) => item.image),
      ...featureCards('zh-CN').map((item) => item.image),
    ]
    for (const src of images) expect(existsSync(resolve(PUBLIC, `.${src}`))).toBe(true)
    for (const item of showcaseCases('zh-CN')) {
      expect(ids.has(item.id)).toBe(true)
      expect(caseHref(item.id)).toBe(`/explore#inspirations/${item.id}`)
    }
    expect(caseHref(null)).toBe('/explore')
    expect(showcaseCases('en').map((item) => item.title)).not.toContain(undefined)
  })

  it('starter prompts start from the library originals', () => {
    for (const item of starterPrompts('en')) {
      const original = prompts.get(item.id)
      expect(original).toBeDefined()
      expect(original).toContain(item.prompt.slice(0, 40))
    }
  })

  it('keeps the contact email wrappable and the close hit target at 44px', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../marketing.css'), 'utf8')
    const mail = css.slice(css.indexOf('.cbox .ct span.cmail'))
    expect(mail.startsWith('.cbox .ct span.cmail')).toBe(true)
    expect(mail.slice(0, mail.indexOf('}'))).toContain('overflow-wrap: anywhere')
    expect(mail.slice(0, mail.indexOf('}'))).not.toContain('ellipsis')
    const close = css.slice(css.indexOf('.cbox .cx::before'), css.indexOf('.cbox .copt {'))
    expect(close).toContain('width: 44px')
    expect(close).toContain('height: 44px')
  })

  it('renders only email in the contact dialog and leaves WeChat empty', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = renderToStaticMarkup(createElement(ContactPanel, { locale, onClose: () => {} }))
      expect(html).toContain(marketingCopy[locale].contact.title)
      expect(html).not.toContain('x.com/')
      expect(html).not.toContain('@Muluk656')
      expect(html).not.toContain('打开 X')
      expect(html).not.toContain('Open X')
      expect(html).toContain(CONTACT_EMAIL)
      expect(html).toContain(`href="mailto:${CONTACT_EMAIL}"`)
      expect(html).toContain(marketingCopy[locale].contact.copy)
      expect(html).toContain('data-slot="contact-email"')
      expect(html).toContain('class="cmail"')
      expect(html).toContain('class="cacts"')
      expect(html).not.toContain('data-contact-channel="wechat"')
    }
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
