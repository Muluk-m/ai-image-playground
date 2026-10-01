// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STARTUP_GUARD_SCRIPT, startupGuardPlugin } from '../../boot/vitePlugin'

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

it('ignores optional manifest and favicon resource failures', () => {
  for (const rel of ['manifest', 'icon', 'apple-touch-icon', 'preload']) {
    const link = document.createElement('link')
    link.rel = rel
    document.head.append(link)
    link.dispatchEvent(new Event('error'))
    link.remove()
  }
  expect(document.getElementById('boot-error')?.hidden).toBe(true)
})
it('keeps an error panel visible if a delayed bootstrap tries to dismiss it', () => {
  vi.advanceTimersByTime(30000)
  document.getElementById('boot')?.classList.add('is-done')
  const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
  const style = document.createElement('style')
  style.textContent = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
  document.head.append(style)
  expect(getComputedStyle(document.getElementById('boot')!).opacity).toBe('1')
  expect(getComputedStyle(document.getElementById('boot')!).pointerEvents).toBe('auto')
  style.remove()
})
it('changes the HTML identity when only the recovery markup changes', () => {
  const transform = startupGuardPlugin().transformIndexHtml.handler
  const base = '<html><head></head><body><div id="boot">Retry</div></body></html>'
  const first = transform(base)
  const second = transform(base.replace('Retry', 'Reload'))
  expect(first).toContain('id="startup-guard"')
  expect(first?.match(/aip-html-build" content="([^"]+)/)?.[1]).not.toBe(
    second?.match(/aip-html-build" content="([^"]+)/)?.[1],
  )
})

it('keeps recovery available when required styles fail even if React commits', () => {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/assets/main-missing.css'
  document.head.append(link)
  // A head stylesheet can fail before the parser creates the body splash.
  const boot = document.getElementById('boot')!
  boot.remove()
  link.dispatchEvent(new Event('error'))
  document.body.append(boot)
  document.dispatchEvent(new Event('app:boot-ready'))
  expect(document.getElementById('boot-error')?.hidden).toBe(false)
  expect(document.getElementById('boot-retry')?.onclick).toBeTypeOf('function')
  vi.advanceTimersByTime(60000)
  expect(document.getElementById('boot')?.dataset.state).toBe('error')
  link.remove()
})
