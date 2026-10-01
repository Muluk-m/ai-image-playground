// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STARTUP_GUARD_SCRIPT } from '../../boot/vitePlugin'

const workerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
const unregister = vi.fn().mockResolvedValue(true)
beforeEach(() => {
  unregister.mockClear()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistrations: () => Promise.resolve([{ unregister }]),
    },
  })
  vi.useFakeTimers()
  localStorage.setItem('aip.locale', 'zh-CN')
  const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
  document.body.innerHTML = html.slice(html.indexOf('<body'), html.indexOf('</body>') + 7)
  window.eval(STARTUP_GUARD_SCRIPT)
})
afterEach(() => {
  document.dispatchEvent(new Event('app:boot-ready'))
  vi.useRealTimers()
  document.body.innerHTML = ''
  localStorage.removeItem('aip.locale')
  if (workerDescriptor) Object.defineProperty(navigator, 'serviceWorker', workerDescriptor)
  else Reflect.deleteProperty(navigator, 'serviceWorker')
})

it('offers recovery when the entry script fails before React exists', () => {
  const script = document.createElement('script')
  script.type = 'module'
  script.src = '/assets/main-missing.js'
  document.body.append(script)
  script.dispatchEvent(new Event('error'))
  expect(document.getElementById('boot-error')?.hidden).toBe(false)
  expect(document.getElementById('root')?.children.length).toBe(0)
  expect(document.getElementById('boot-retry')?.textContent).toBe('重新加载')
})
it('stops indefinite loading even when a module request never finishes', () => {
  vi.advanceTimersByTime(30000)
  expect(document.getElementById('boot')?.dataset.state).toBe('error')
})
it('catches a failed asynchronous bootstrap', () => {
  window.dispatchEvent(new Event('unhandledrejection'))
  expect(document.getElementById('boot-error')?.hidden).toBe(false)
})
it('does not replace a ready application with a timeout or later exception', () => {
  document.dispatchEvent(new Event('app:boot-ready'))
  vi.advanceTimersByTime(60000)
  window.dispatchEvent(new ErrorEvent('error'))
  expect(document.getElementById('boot')).toBeNull()
})
it('does not mistake an image failure for a failed application', () => {
  document.querySelector('#boot img')?.dispatchEvent(new Event('error'))
  expect(document.getElementById('boot-error')?.hidden).toBe(true)
})

it('restores recovery after the entry loads but the lazy workspace fails', () => {
  document.getElementById('boot')?.classList.add('is-done')
  window.dispatchEvent(new Event('unhandledrejection'))
  expect(document.getElementById('boot')?.classList.contains('is-done')).toBe(false)
  expect(document.getElementById('boot-error')?.hidden).toBe(false)
})
it('keeps the timeout active while the lazy workspace is still pending', () => {
  document.getElementById('boot')?.classList.add('is-done')
  vi.advanceTimersByTime(30000)
  expect(document.getElementById('boot')?.classList.contains('is-done')).toBe(false)
  expect(document.getElementById('boot-error')?.hidden).toBe(false)
})

it('unregisters legacy workers without depending on the app module or deleting user storage', async () => {
  localStorage.setItem('preserved-user-setting', 'keep')
  await Promise.resolve()
  expect(unregister).toHaveBeenCalled()
  expect(localStorage.getItem('preserved-user-setting')).toBe('keep')
  localStorage.removeItem('preserved-user-setting')
})
