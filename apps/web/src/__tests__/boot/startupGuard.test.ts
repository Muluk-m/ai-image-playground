// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CLIENT_ERRORS_PATH } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BOOT_READY_EVENT,
  PRELOAD_RELOAD_STORAGE_KEY,
  RELOAD_QUERY_PARAM,
} from '../../boot/constants'
import { BOOT_REPORT_PATH, STARTUP_GUARD_SCRIPT, startupGuardPlugin } from '../../boot/vitePlugin'
import { LOCALE_STORAGE_KEY } from '../../i18n/storageKey'

/** jsdom's Blob has no `text()`. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

const sourceHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
const bodyHtml = sourceHtml.slice(sourceHtml.indexOf('<body'), sourceHtml.indexOf('</body>') + 7)

const workerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
const unregister = vi.fn().mockResolvedValue(true)
const installed: Array<() => void> = []
const replace = vi.fn()
const locationMock = {
  get href() {
    return location.href
  },
  get origin() {
    return location.origin
  },
  get pathname() {
    return location.pathname
  },
  get hash() {
    return location.hash
  },
  replace,
}
function installGuard() {
  for (const remove of installed.splice(0)) remove()

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
  window.Function('location', STARTUP_GUARD_SCRIPT)(locationMock)
  onWindow.mockRestore()
  onDocument.mockRestore()
}
beforeEach(() => {
  unregister.mockClear()
  replace.mockClear()
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistrations: () => Promise.resolve([{ unregister }]),
    },
  })
  vi.useFakeTimers()
  localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
  document.body.innerHTML = bodyHtml
  // Existing failure-panel cases exercise the page after its automatic retry.
  sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, String(Date.now()))
  installGuard()
})
afterEach(() => {
  document.dispatchEvent(new Event(BOOT_READY_EVENT))
  vi.useRealTimers()
  document.body.innerHTML = ''
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  history.replaceState(null, '', '/')
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
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  const first = preloadError()
  expect(first.defaultPrevented).toBe(true)
  expect(Number(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY))).toBeGreaterThan(0)
  expect(document.getElementById('boot')).toBeNull()

  document.body.innerHTML = bodyHtml
  installGuard()
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

it('reports why the workspace could not open, with the exceptions seen before it', async () => {
  vi.useRealTimers()
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        bff: {
          enabled: true,
          baseUrl: '',
          baseUrlsByOrigin: { [location.origin]: 'https://api.test' },
        },
      }),
    ),
  )
  const sendBeacon = vi.fn((_url: string, _body: Blob) => true)
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon })
  try {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'boom',
        error: new TypeError('boom'),
        filename: 'main.js',
      }),
    )
    const script = document.createElement('script')
    script.type = 'module'
    script.src = '/assets/main-missing.js'
    document.body.append(script)
    script.dispatchEvent(new Event('error'))
    script.dispatchEvent(new Event('error'))

    await vi.waitFor(() => expect(sendBeacon).toHaveBeenCalledTimes(1))
    const [url, blob] = sendBeacon.mock.calls[0]!
    expect(url).toBe(`https://api.test${CLIENT_ERRORS_PATH}`)
    const [report] = JSON.parse(await readBlob(blob)).errors
    expect(report).toMatchObject({
      kind: 'boot',
      message: 'resource',
      context: {
        detail: { tag: 'script', src: expect.stringContaining('/assets/main-missing.js') },
        rendered: false,
        errors: [expect.objectContaining({ type: 'error', message: 'boom' })],
      },
    })
  } finally {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'sendBeacon')
  }
})
it('posts boot reports to the shared client error path', () => {
  expect(BOOT_REPORT_PATH).toBe(CLIENT_ERRORS_PATH)
})

it('refreshes failed required CSS once and preserves the project, query, and hash', () => {
  history.replaceState(null, '', '/p/project?mode=canvas#selection')
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/assets/main-missing.css'
  document.head.append(link)
  try {
    link.dispatchEvent(new Event('error'))
    link.dispatchEvent(new Event('error'))
    expect(replace).toHaveBeenCalledTimes(1)
    const next = new URL(replace.mock.calls[0]![0])
    expect(next.pathname).toBe('/p/project')
    expect(next.searchParams.get('mode')).toBe('canvas')
    expect(next.hash).toBe('#selection')
    expect(next.searchParams.get(RELOAD_QUERY_PARAM)).toBe(String(Date.now()))
    expect(errorPanelVisible()).toBe(false)
    installGuard()
    link.dispatchEvent(new Event('error'))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(errorPanelVisible()).toBe(true)
  } finally {
    link.remove()
  }
})
it('automatically refreshes a failed entry script too', () => {
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  const script = document.createElement('script')
  script.type = 'module'
  script.src = '/assets/main-missing.js'
  document.body.append(script)
  script.dispatchEvent(new Event('error'))
  expect(replace).toHaveBeenCalledTimes(1)
  expect(errorPanelVisible()).toBe(false)
})
it('uses a new HTML URL when the user clicks reload even inside the retry window', () => {
  vi.advanceTimersByTime(30000)
  document.getElementById('boot-retry')!.click()
  expect(replace).toHaveBeenCalledTimes(1)
  expect(new URL(replace.mock.calls[0]![0]).searchParams.has(RELOAD_QUERY_PARAM)).toBe(true)
})
it('removes the recovery parameter after first render while preserving the rest of the URL', () => {
  history.replaceState(
    { saved: true },
    '',
    `/p/project?mode=canvas&${RELOAD_QUERY_PARAM}=123#selection`,
  )
  ready()
  expect(location.pathname + location.search + location.hash).toBe(
    '/p/project?mode=canvas#selection',
  )
  expect(history.state).toEqual({ saved: true })
})
it('ignores optional font styles even after they switch to screen media', () => {
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.media = 'all'
  link.setAttribute('data-optional-style', '')
  document.head.append(link)
  try {
    link.dispatchEvent(new Event('error'))
    ready()
    expect(replace).not.toHaveBeenCalled()
    expect(document.getElementById('boot')).toBeNull()
  } finally {
    link.remove()
  }
})
it('shows recovery without an automatic loop when session storage cannot be written', () => {
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  try {
    expect(preloadError().defaultPrevented).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    expect(errorPanelVisible()).toBe(true)
  } finally {
    setItem.mockRestore()
  }
})
it('waits for manual recovery when the browser is offline', () => {
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  try {
    expect(preloadError().defaultPrevented).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    expect(errorPanelVisible()).toBe(true)
  } finally {
    online.mockRestore()
  }
})
