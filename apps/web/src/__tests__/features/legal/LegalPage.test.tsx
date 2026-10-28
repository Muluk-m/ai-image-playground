// @vitest-environment jsdom
import { SUPPORT_CONTACT, SUPPORT_MAILTO, SUPPORT_X_URL } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LegalPage from '../../../features/legal/LegalPage'
import { ensureLocaleLoaded, i18next } from '../../../i18n'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  history.replaceState(null, '', '/terms')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
})

function render() {
  act(() => {
    root.render(<LegalPage />)
  })
}

function contactLink(): HTMLAnchorElement {
  const link = document.querySelector<HTMLAnchorElement>('a[href="/#contact"]')
  if (!link) throw new Error('missing contact link')
  return link
}

describe('LegalPage contact', () => {
  it('makes the published email and X handle links and opens contact on the page', () => {
    render()
    const mail = [...document.querySelectorAll<HTMLAnchorElement>('a')].filter(
      (link) => link.getAttribute('href') === SUPPORT_MAILTO,
    )
    expect(mail.length).toBeGreaterThanOrEqual(2)
    expect(mail.every((link) => link.textContent === SUPPORT_CONTACT.email)).toBe(true)
    const x = [...document.querySelectorAll<HTMLAnchorElement>('a')].filter(
      (link) => link.getAttribute('href') === SUPPORT_X_URL,
    )
    expect(x.length).toBeGreaterThanOrEqual(2)
    expect(x.every((link) => link.textContent === `@${SUPPORT_CONTACT.xHandle}`)).toBe(true)
    expect(x.every((link) => link.target === '_blank')).toBe(true)

    const link = contactLink()
    expect(link.textContent).toBe('联系我们')
    act(() => link.click())
    expect(window.location.pathname).toBe('/terms')
    expect(window.location.hash).toBe('')
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('联系我们')
    expect(dialog?.textContent).toContain(SUPPORT_CONTACT.email)
    expect(dialog?.textContent).toContain(`@${SUPPORT_CONTACT.xHandle}`)
    expect(dialog?.querySelector(`a[href="${SUPPORT_MAILTO}"]`)).not.toBeNull()
    expect(dialog?.textContent).not.toContain('运营')
  })

  it('offers the same contact entry on the privacy policy', () => {
    history.replaceState(null, '', '/privacy')
    render()
    expect(contactLink().textContent).toBe('联系我们')
    expect(document.body.textContent).toContain(SUPPORT_CONTACT.email)
    act(() => contactLink().click())
    expect(window.location.pathname).toBe('/privacy')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(SUPPORT_CONTACT.email)
  })

  it('uses the English contact wording', async () => {
    render()
    await act(async () => {
      await ensureLocaleLoaded('en')
      await i18next.changeLanguage('en')
    })
    expect(contactLink().textContent).toBe('contact us')
    expect(document.body.textContent).toContain(
      `email ${SUPPORT_CONTACT.email}, contact @${SUPPORT_CONTACT.xHandle} on X, or contact us.`,
    )
    act(() => contactLink().click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Contact us')
  })
})
