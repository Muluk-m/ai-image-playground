import type { BillingSettings, PlanPrice } from '@image-playground/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { contactChannels } from '../../../features/billing/billing-display'
import { ContactSurface, QrZoomSurface } from '../../../features/billing/ContactModal'

function settings(overrides: Partial<BillingSettings> = {}): BillingSettings {
  return {
    contact_wechat: 'operator-wechat',
    payment_qr_url: '/op/payment-qr.png',
    contact_qr_url: '/op/contact-qr.png',
    guidance: '备注用户名后转账，客服核对到账',
    ...overrides,
  }
}

const price: PlanPrice = {
  period_months: 3,
  original_price_cents: 29_900,
  discount_price_cents: 19_900,
  discount_ends_at: Date.now() + 86_400_000,
  effective_price_cents: 19_900,
}

function renderSurface(
  overrides: Partial<BillingSettings> = {},
  planPrice: PlanPrice | null = price,
): string {
  return renderToStaticMarkup(
    <ContactSurface
      title={planPrice === null ? '联系客服充值' : '专业版'}
      price={planPrice}
      channels={contactChannels(settings(overrides), '请联系运营者')}
      onClose={() => {}}
    />,
  )
}

describe('ContactSurface', () => {
  it('shows both QR codes with their own labels', () => {
    const markup = renderSurface()

    expect(markup).toContain('src="/op/payment-qr.png"')
    expect(markup).toContain('alt="收款码"')
    expect(markup).toContain('src="/op/contact-qr.png"')
    expect(markup).toContain('alt="客服微信二维码"')
    expect(markup).toContain('客服微信</figcaption>')
  })

  it('names the selected plan and strikes through the original price when discounted', () => {
    const markup = renderSurface()

    expect(markup).toContain('专业版')
    expect(markup).toContain('三个月')
    expect(markup).toContain('¥199')
    expect(markup).toContain('<del class="text-sm text-muted-foreground">¥299</del>')
  })

  it('shows no struck price when the plan is not discounted', () => {
    const markup = renderSurface({}, { ...price, original_price_cents: 19_900 })

    expect(markup).toContain('¥199')
    expect(markup).not.toContain('<del')
  })

  it('shows no price block when opened without a plan', () => {
    const markup = renderSurface({}, null)

    expect(markup).toContain('联系客服充值')
    expect(markup).not.toContain('¥')
  })

  it('renders the operator guidance', () => {
    expect(renderSurface()).toContain('备注用户名后转账，客服核对到账')
  })

  it('falls back to the wechat handle when the contact QR is missing', () => {
    const markup = renderSurface({ contact_qr_url: '' })

    expect(markup).not.toContain('alt="客服微信二维码"')
    expect(markup).toContain('联系微信 operator-wechat')
  })

  it('falls back to the caller text when no contact channel is configured', () => {
    expect(renderSurface({ contact_qr_url: '', contact_wechat: '' })).toContain(
      '联系微信 请联系运营者',
    )
  })

  it('offers each QR its own zoom control with a zoom-in affordance', () => {
    const markup = renderSurface()

    expect(markup).toContain('aria-label="放大收款码"')
    expect(markup).toContain('aria-label="放大客服微信"')
    expect(markup.match(/cursor-zoom-in/g)).toHaveLength(2)
  })

  it('drops the QR row entirely when no QR is configured', () => {
    const markup = renderSurface({ contact_qr_url: '', payment_qr_url: '' })

    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('flex flex-wrap justify-center gap-6')
  })
})

describe('QrZoomSurface', () => {
  const tile = { src: '/op/payment-qr.png', alt: '收款码', label: '收款码' }

  it('fills the viewport short edge on a white backing a scanner can read', () => {
    const markup = renderToStaticMarkup(<QrZoomSurface tile={tile} onClose={() => {}} />)

    expect(markup).toContain('h-[min(85dvh,85vw)]')
    expect(markup).toContain('w-[min(85dvh,85vw)]')
    expect(markup).toContain('object-contain')
    expect(markup).toContain('bg-on-media')
    expect(markup).toContain('cursor-zoom-out')
    expect(markup).toContain('alt="收款码"')
  })

  it('announces itself as the topmost dialog so the contact modal does not hide it', () => {
    const markup = renderToStaticMarkup(<QrZoomSurface tile={tile} onClose={() => {}} />)

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-label="收款码放大图"')
  })
})
