// @vitest-environment jsdom
import { SUPPORT_CONTACT } from '@image-playground/shared/support-contact'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
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
  // 窄屏不能把邮箱截成省略号。
  const email = document.querySelector('[data-slot="contact-email"]')
  expect(email?.textContent).toBe(SUPPORT_CONTACT.email)
  expect(email?.className).not.toContain('truncate')
  act(() => root.unmount())
  host.remove()
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
})

it('没有 Clipboard API 时用传统复制兜底，仍显示已复制', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  const execCommand = vi.fn(() => true)
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<ContactDialog onClose={() => {}} />))
  const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === '复制')
  await act(async () => copy?.click())
  expect(execCommand).toHaveBeenCalledWith('copy')
  expect(document.body.textContent).toContain('已复制')
  act(() => root.unmount())
  host.remove()
})
