// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthContextProvider } from '../../../auth/AuthContext'
import {
  imagesPerMonth,
  monthlyEquivalentCents,
  PRICING_PLANS,
  rechargeCredits,
} from '../../../features/pricing/catalog'
import PricingPage from '../../../features/pricing/PricingPage'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  history.replaceState(null, '', '/pricing')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
})

function renderPage(): void {
  act(() => {
    root.render(<PricingPage />)
  })
}

describe('定价目录', () => {
  it('按种子价折算张数，季付和年付折回每月原价', () => {
    expect(PRICING_PLANS.map((plan) => imagesPerMonth(plan.monthlyCredits))).toEqual([
      660, 2200, 6000,
    ])
    for (const plan of PRICING_PLANS) {
      expect(monthlyEquivalentCents(plan.prices[3], 3)).toBe(plan.prices[1])
      expect(monthlyEquivalentCents(plan.prices[12], 12)).toBe(plan.prices[1])
    }
    expect(rechargeCredits(10)).toBe(4000)
    expect(rechargeCredits(100)).toBe(40000)
  })
})

describe('定价页', () => {
  it('列出三档月付价格、充值档和展开的问题', () => {
    renderPage()
    const text = host.textContent ?? ''
    expect(text).toContain('定价')
    expect(text).toContain('入门')
    expect(text).toContain('标准')
    expect(text).toContain('专业')
    expect(text).toContain('66,000')
    expect(text).toContain('220,000')
    expect(text).toContain('600,000')
    expect(text).toContain('4,000')
    expect(text).toContain('40,000')
    expect(text).toContain('购买的当月马上发放')
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('定价')
    expect(document.title).toBe('定价 · 幕芽 Muvloom')
  })

  it('切换到年付后，卡片改成一次付清并写出每月折合', () => {
    renderPage()
    expect(host.textContent ?? '').not.toContain('折合')
    const yearly = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '年付',
    )
    act(() => yearly?.click())
    const prices = [...host.querySelectorAll('[aria-live="polite"]')].map(
      (node) => node.textContent,
    )
    expect(prices).toEqual(['¥588/年', '¥1,548/年', '¥3,588/年'])
    expect(host.textContent ?? '').toContain('折合 ¥49/月')
  })

  it('未登录时点升级打开登录，而不是离开定价页', () => {
    let opened = false
    act(() => {
      root.render(
        <AuthContextProvider
          value={{
            enabled: true,
            user: null,
            login: () => {
              opened = true
            },
            logout: async () => {},
          }}
        >
          <PricingPage />
        </AuthContextProvider>,
      )
    })
    const upgrade = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '立即升级',
    )
    act(() => upgrade?.click())
    expect(opened).toBe(true)
    expect(location.pathname).toBe('/pricing')
  })
})
