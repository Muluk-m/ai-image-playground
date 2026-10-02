// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BOOT_READY_EVENT, PRELOAD_RELOAD_STORAGE_KEY } from '../../boot/constants'
import { STARTUP_GUARD_SCRIPT, startupGuardPlugin } from '../../boot/vitePlugin'
import { LOCALE_STORAGE_KEY } from '../../i18n/storageKey'

const workerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
const unregister = vi.fn().mockResolvedValue(true)
const installed: Array<() => void> = []
beforeEach(() => {
  unregister.mockClear()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistrations: () => Promise.resolve([{ unregister }]),
    },
  })
  vi.useFakeTimers()
  localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
  const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
  document.body.innerHTML = html.slice(html.indexOf('<body'), html.indexOf('</body>') + 7)
  // The guard listens for the page's lifetime; record its listeners so each test gets a fresh guard.
  const record = (target: Window | Document) => {
    const add = target.addEventListener.bind(target)
    return (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      installed.push(() => target.removeEventListener(type, listener, options))
      add(type, listener, options)
    }
  }
  const onWindowAdd = record(window)
  const onDocumentAdd = record(document)
  const onWindow = vi.spyOn(window, 'addEventListener').mockImplementation(onWindowAdd)
  const onDocument = vi.spyOn(document, 'addEventListener').mockImplementation(onDocumentAdd)
  window.eval(STARTUP_GUARD_SCRIPT)
  onWindow.mockRestore()
  onDocument.mockRestore()
})
afterEach(() => {
  document.dispatchEvent(new Event(BOOT_READY_EVENT))
  vi.useRealTimers()
  document.body.innerHTML = ''
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  for (const remove of installed.splice(0)) remove()
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
const ready = () => document.dispatchEvent(new Event(BOOT_READY_EVENT))
const errorPanelVisible = () => document.getElementById('boot-error')?.hidden === false
const preloadError = () => {
  const event = new Event('vite:preloadError', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

it('stops indefinite loading when React never renders', () => {
  vi.advanceTimersByTime(30000)
  expect(document.getElementById('boot')?.dataset.state).toBe('error')
})
it('leaves runtime exceptions before the first render to the app', () => {
  window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
  window.dispatchEvent(new Event('unhandledrejection'))
  expect(errorPanelVisible()).toBe(false)
})
it('hands loading and errors to whatever screen React renders first', () => {
  ready()
  vi.advanceTimersByTime(60000)
  window.dispatchEvent(new ErrorEvent('error'))
  expect(document.getElementById('boot')).toBeNull()
})
it('withdraws a timeout panel once a slow first render arrives', () => {
  vi.advanceTimersByTime(30000)
  expect(errorPanelVisible()).toBe(true)
  ready()
  expect(document.getElementById('boot')).toBeNull()
})
it('does not mistake an image failure for a failed application', () => {
  document.querySelector('#boot img')?.dispatchEvent(new Event('error'))
  expect(errorPanelVisible()).toBe(false)
})
it('localizes the recovery panel from the stored app locale', () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
  vi.advanceTimersByTime(30000)
  expect(document.getElementById('boot-retry')?.textContent).toBe('Reload')
})

it('reloads once when stale HTML references a deleted chunk, then asks instead of looping', () => {
  ready()
  const first = preloadError()
  expect(first.defaultPrevented).toBe(true)
  expect(Number(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY))).toBeGreaterThan(0)
  expect(document.getElementById('boot')).toBeNull()

  const second = preloadError()
  expect(second.defaultPrevented).toBe(false)
  expect(errorPanelVisible()).toBe(true)
})
it('retries a chunk failure again once the previous reload is old', () => {
  sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, String(Date.now() - 120000))
  expect(preloadError().defaultPrevented).toBe(true)
  expect(errorPanelVisible()).toBe(false)
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
  expect(errorPanelVisible()).toBe(false)
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
  ready()
  expect(errorPanelVisible()).toBe(true)
  vi.advanceTimersByTime(60000)
  expect(document.getElementById('boot')?.dataset.state).toBe('error')
  link.remove()
})
