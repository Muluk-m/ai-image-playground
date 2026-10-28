// @vitest-environment jsdom
import { SUPPORT_CONTACT } from '@image-playground/shared/support-contact'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import ContactDialog from '../../components/ContactDialog'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('联系弹窗只给邮箱，没有 X 私信', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<ContactDialog onClose={() => {}} />))
  const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  expect(hrefs).toEqual([`mailto:${SUPPORT_CONTACT.email}`])
  expect(document.body.textContent).toContain(SUPPORT_CONTACT.email)
  expect(document.body.textContent).toContain('复制')
  expect(document.body.textContent).toContain('写邮件')
  expect(document.body.textContent).not.toContain(SUPPORT_CONTACT.xHandle)
  expect(document.body.textContent).not.toContain('发私信')
  act(() => root.unmount())
  host.remove()
})
