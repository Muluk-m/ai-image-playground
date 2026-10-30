import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContactPanel } from '../components/ContactModal'
import { MarketingHome } from '../components/MarketingHome'
import { CONTACT_EMAIL, caseRows, HOME_IMAGES, marketingCopy } from '../marketing'

const PUBLIC = resolve(import.meta.dirname, '../../../web/public')

function render(locale: 'zh-CN' | 'en'): string {
  return renderToStaticMarkup(createElement(MarketingHome, { locale, start: () => {} }))
}

function visibleText(html: string): string {
  return html
    .replace(/<br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
}

describe('marketing home', () => {
  it('follows the workbench theme and offers a light or dark switch', () => {
    const html = render('zh-CN')
    expect(html).toContain('class="mkt-theme" aria-label="切换亮色或暗色"')
    const css = readFileSync(resolve(import.meta.dirname, '../marketing.css'), 'utf8')
    expect(css).toMatch(/\.dark \.mkt \{[^}]*--mkt-bg: #111311;[^}]*color-scheme: dark;/)
  })
  it('renders the approved Chinese copy', () => {
    const html = render('zh-CN')
    const text = visibleText(html)
    expect(html).toContain('<h1 class="mkt-title">幕芽：图片和视频的<br/>在线创作工具</h1>')
    expect(text).toContain('可以附上参考图，结果直接显示在对话里。')
    for (const label of ['案例', '功能', '灵感库', '使用指南', '定价', 'EN', '登录', '开始使用'])
      expect(text).toContain(label)
    expect(text).toContain('杯型和场景不变，釉色换成米白、赤陶、黑釉、青釉，各出一张。')
    expect(html).toContain('<span class="mkt-nw">各出一张。</span>')
    expect(text).toContain('把杯子换成哑光黑釉，杯型、咖啡和桌面光影保持不变')
    expect(text).toContain('用这只青釉杯拍一张杯口特写，白天自然光，木桌，画面安静一点')
    expect(html).toContain('<span class="mkt-nw">画面安静一点</span>')
    for (const caption of [
      '米白釉',
      '赤陶釉',
      '黑釉',
      '青釉',
      '原图',
      '修改后 · Image 2.5 Flare',
      '参考图',
      '生成结果 · Image 2.5 Flare',
    ])
      expect(html).toContain(`<figcaption>${caption}</figcaption>`)
    expect(html.match(/class="mkt-said-k">输入</g)).toHaveLength(3)
    for (const fact of [
      '一次最多 16\u00a0张',
      '局部重绘、擦除、抠图、扩图、裁剪',
      '5–15\u00a0秒，最高 1080p，可以用图片作首帧',
      '参考图和每一版结果放在同一张画布上',
      '商品、人物、场景可以存成素材，生成时引用',
      '网页版，不用安装，项目和素材跟账号同步',
    ])
      expect(text).toContain(fact)
    expect(text).toContain('按积分计费')
    expect(text).toContain('查看定价 →')
    expect(text).toContain('图片和视频创作工具')
    expect(text).toContain('© 2026 Muvloom 幕芽')
    expect(html).toContain('href="/guide/"')
    expect(html).toContain('href="/terms"')
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('href="/explore"')
    expect(html).toContain('href="/en/"')
    expect(html).toContain('src="/brand/muvloom-mark.svg"')
    expect(html).toContain('loading="lazy"')
  })

  it('keeps exactly one solid primary button and no gift-credit or emoji copy', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const html = render(locale)
      expect(html.match(/mkt-btn-primary/g)).toHaveLength(1)
      expect(html).not.toMatch(/2000|赠送|free credits/i)
      expect(html).not.toMatch(/\p{Emoji_Presentation}/u)
    }
  })

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

  it('translates the English page', () => {
    const html = render('en')
    const text = visibleText(html)
    expect(html).toContain(
      '<h1 class="mkt-title">Muvloom: online creation<br/>tool for images and video</h1>',
    )
    expect(text).toContain('Get started')
    expect(text).toContain('Up to 16 images at a time')
    expect(html).toContain('href="/guide/en/"')
    expect(html).toContain('href="/"')
    expect(text).not.toMatch(/开始使用|案例|功能|输入/)
    expect(html.match(/class="mkt-said-k">Prompt</g)).toHaveLength(3)
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
