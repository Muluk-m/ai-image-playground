// @vitest-environment jsdom
import { SUPPORT_CONTACT, SUPPORT_X_URL } from '@image-playground/shared/support-contact'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import ContactDialog from '../../components/ContactDialog'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('联系弹窗给出 X 私信和邮箱，渠道取自 support-contact', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<ContactDialog onClose={() => {}} />))
  const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  expect(hrefs).toContain(SUPPORT_X_URL)
  expect(hrefs).toContain(`mailto:${SUPPORT_CONTACT.email}`)
  expect(document.body.textContent).toContain(SUPPORT_CONTACT.email)
  act(() => root.unmount())
  host.remove()
})
