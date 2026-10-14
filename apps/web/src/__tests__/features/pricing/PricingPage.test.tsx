// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../../auth/AuthContext'
import {
  imagesPerMonth,
  loadPublicCatalog,
  monthlyEquivalentCents,
  parsePublicCatalog,
  rechargeCredits,
} from '../../../features/pricing/catalog'
import PricingPage from '../../../features/pricing/PricingPage'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LIVE_CATALOG = {
  plans: [
    plan('starter', '入门', 66_000, 1, 10, [
      [1, 4900, 3900],
      [3, 13500, 10500],
      [12, 46800, 34800],
    ]),
    plan('standard', '标准', 220_000, 2, 20, [
      [1, 9900, 7900],
      [3, 26700, 21300],
      [12, 94800, 70800],
    ]),
    plan('professional', '专业', 600_000, 3, 30, [
      [1, 19900, 15900],
      [3, 53700, 42900],
      [12, 190800, 142800],
    ]),
  ],
  recharge: { credits_per_yuan: 400, amounts_yuan: [10, 50, 100] },
  image_anchor: { model: 'gpt-image-2', credits_per_image: 100 },
  referral: {
    inviter_registration_credits: 200,
    invitee_registration_credits: 200,
    paid_reward_basis_points: 500,
    credits_per_yuan: 100,
  },
}

function plan(
  id: string,
  name: string,
  monthlyCredits: number,
  concurrency: number,
  sortOrder: number,
  prices: Array<[number, number, number]>,
) {
  return {
    id,
    name,
    monthly_credits: monthlyCredits,
    max_concurrent_tasks: concurrency,
    sort_order: sortOrder,
    prices: prices.map(([period, original, effective]) => ({
      period_months: period,
      original_price_cents: original,
      discount_price_cents: effective,
      discount_ends_at: 1,
      effective_price_cents: effective,
    })),
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  history.replaceState(null, '', '/pricing')
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.test' } })
  installCatalog(LIVE_CATALOG)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
  vi.unstubAllGlobals()
})

function installCatalog(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.endsWith('/api/billing/public-catalog')) throw new Error(`unexpected ${url}`)
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
}

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(<PricingPage />)
  })
}

describe('定价目录', () => {
  it('按接口返回的单价折算张数', async () => {
    expect(imagesPerMonth(66_000, 100)).toBe(660)
    expect(imagesPerMonth(220_000, 80)).toBe(2750)
    expect(monthlyEquivalentCents(34800, 12)).toBe(2900)
    expect(rechargeCredits(10, 400)).toBe(4000)
    expect(rechargeCredits(100, 400)).toBe(40000)
    expect(parsePublicCatalog({ settings: { contact_wechat: 'secret' } })).toBeNull()
    expect(parsePublicCatalog(LIVE_CATALOG)?.plans.map((item) => item.monthlyCredits)).toEqual([
      66_000, 220_000, 600_000,
    ])
    const withExtraCycle = structuredClone(LIVE_CATALOG)
    withExtraCycle.plans[0]?.prices.push({
      period_months: 6,
      original_price_cents: 20_000,
      discount_price_cents: 20_000,
      discount_ends_at: 1,
      effective_price_cents: 20_000,
    })
    expect(parsePublicCatalog(withExtraCycle)?.plans[0]?.prices[1]).toBeDefined()
    expect(parsePublicCatalog(withExtraCycle)?.plans[0]?.prices).not.toHaveProperty('6')
    const negative = structuredClone(LIVE_CATALOG)
    const first = negative.plans[0]?.prices[0]
    if (first) first.effective_price_cents = -100
    expect(parsePublicCatalog(negative)).toBeNull()
    await expect(
      loadPublicCatalog((_input, init) => {
        if (init?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }, AbortSignal.abort()),
    ).rejects.toThrow('aborted')
  })
})

describe('定价页', () => {
  it('列出接口返回的月付价格、充值档和展开的问题', async () => {
    await renderPage()
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
    expect(text).toContain('1 元 400 积分')
    expect(text).toContain('5%')
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('定价')
    expect(document.title).toBe('定价 · 幕芽 Muvloom')
    const prices = [...host.querySelectorAll('[aria-live="polite"]')].map(
      (node) => node.textContent,
    )
    expect(prices).toEqual(['¥39/月', '¥79/月', '¥159/月'])
  })

  it('接口改价后页面跟着变，不再使用写死的快照', async () => {
    const changed = structuredClone(LIVE_CATALOG)
    changed.plans[0]?.prices[0] && (changed.plans[0].prices[0].effective_price_cents = 1200)
    changed.image_anchor.credits_per_image = 80
    installCatalog(changed)
    await renderPage()
    const prices = [...host.querySelectorAll('[aria-live="polite"]')].map(
      (node) => node.textContent,
    )
    expect(prices[0]).toBe('¥12/月')
    expect(host.textContent ?? '').toContain('825')
  })

  it('切换到年付后，卡片改成一次付清并写出每月折合', async () => {
    await renderPage()
    expect(host.textContent ?? '').not.toContain('折合')
    const yearly = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '年付',
    )
    act(() => yearly?.click())
    const prices = [...host.querySelectorAll('[aria-live="polite"]')].map(
      (node) => node.textContent,
    )
    expect(prices).toEqual(['¥348/年', '¥708/年', '¥1,428/年'])
    expect(host.textContent ?? '').toContain('折合 ¥29/月')
  })

  it('接口失败时不展示旧价格', async () => {
    installCatalog({ error: 'nope' }, 503)
    await renderPage()
    expect(host.textContent ?? '').toContain('价格没有读出来')
    expect(host.textContent ?? '').not.toContain('¥39')
  })

  it('未登录时点升级打开登录，而不是离开定价页', async () => {
    let opened = false
    await act(async () => {
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
