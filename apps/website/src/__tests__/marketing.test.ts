import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { guideClipUrl } from '../../../web/src/features/guide/content/media'
import { ContactPanel } from '../components/ContactModal'
import { MarketingHome } from '../components/MarketingHome'
import { CONTACT_EMAIL, caseRows, HOME_IMAGES, marketingCopy } from '../marketing'

const PUBLIC = resolve(import.meta.dirname, '../../../web/public')

function render(locale: 'zh-CN' | 'en'): string {
  return renderToStaticMarkup(createElement(MarketingHome, { locale, start: () => {} }))
}

describe('marketing home', () => {
  it('links the pricing page from the top nav, the end row and the footer', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = render(locale)
      const link = `<a href="/pricing">${marketingCopy[locale].nav.pricing}</a>`
      expect(html.indexOf(link)).toBeLessThan(html.indexOf('<header'))
      expect(html.lastIndexOf(link)).toBeGreaterThan(html.indexOf('<footer'))
      expect(html).toContain(`<a href="/pricing">${marketingCopy[locale].pricing.link} →</a>`)
      // 窄屏收起中间导航后，右侧还留着一个「定价」。
      const nav = html.slice(html.indexOf('class="mkt-nav"'), html.indexOf('<header'))
      expect(nav).toContain(
        `<a class="mkt-nav-pricing" href="/pricing">${marketingCopy[locale].nav.pricing}</a>`,
      )
    }
  })

  it('gives the footer a #contact anchor', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = render(locale)
      expect(html).toContain('href="#contact"')
      expect(html.indexOf('id="contact"')).toBeGreaterThan(html.indexOf('<footer'))
    }
  })

  it('plays the promo from the guide clip map', () => {
    const html = render('zh-CN')
    expect(html).toContain(`src="${guideClipUrl('promo-site-zh.webm')}"`)
    expect(html).toContain(`src="${guideClipUrl('promo-site-zh.mp4')}"`)
    expect(html).toContain('poster="/guide-assets/zh/clips/promo-site-zh-poster.webp"')
    expect(html).toContain('preload="none"')
    expect(html).not.toContain('/guide-assets/zh/clips/promo-site-zh.mp4')
    expect(html).not.toContain('/guide-assets/zh/clips/promo-site-zh.webm')
  })

  it('uses only bundled images', () => {
    const images = [
      HOME_IMAGES.hero,
      ...(['zh-CN', 'en'] as const).flatMap((locale) =>
        caseRows(locale).flatMap((row) => row.figures.map((figure) => figure.src)),
      ),
    ]
    for (const src of images) expect(existsSync(resolve(PUBLIC, `.${src}`))).toBe(true)
    for (const row of caseRows('en'))
      for (const figure of row.figures) {
        expect(figure.caption).not.toBe('')
        expect(figure.alt).not.toBe('')
      }
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
