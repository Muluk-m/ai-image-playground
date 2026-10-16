// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CLIENT_ERRORS_PATH } from '@image-playground/shared'
import type { IndexHtmlTransformContext } from 'vite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BOOT_READY_EVENT,
  PRELOAD_RELOAD_STORAGE_KEY,
  PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY,
  RELOAD_QUERY_PARAM,
} from '../../boot/constants'
import {
  BOOT_FADE_MS,
  BOOT_REPORT_PATH,
  SPROUT_HOLD_MS,
  STARTUP_GUARD_SCRIPT,
  startupGuardPlugin,
} from '../../boot/vitePlugin'
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
  get search() {
    return location.search
  },
  get hash() {
    return location.hash
  },
  replace,
}
function installGuard(script = STARTUP_GUARD_SCRIPT) {
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
  window.Function('location', script)(locationMock)
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
  // Existing failure-panel cases exercise the page after both automatic recovery attempts.
  sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, String(Date.now()))
  sessionStorage.setItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY, String(Date.now()))
  installGuard()
})
const finishReveal = () => vi.advanceTimersByTime(SPROUT_HOLD_MS + BOOT_FADE_MS)
afterEach(() => {
  document.dispatchEvent(new Event(BOOT_READY_EVENT))
  if (vi.isFakeTimers()) finishReveal()
  vi.useRealTimers()
  document.body.innerHTML = ''
  localStorage.removeItem(LOCALE_STORAGE_KEY)
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
  for (const remove of installed.splice(0)) remove()
  if (workerDescriptor) Object.defineProperty(navigator, 'serviceWorker', workerDescriptor)
  else Reflect.deleteProperty(navigator, 'serviceWorker')
})

it.each(['/workbench', '/workbench.html', '/image/'])(
  'canonicalizes %s before auth/bootstrap while preserving OAuth and draft suffixes',
  (path) => {
    history.replaceState(null, '', `${path}?auth_session=1&keep=1#draft`)
    const length = history.length
    installGuard()
    expect(location.pathname + location.search + location.hash).toBe('/?auth_session=1&keep=1#draft')
    expect(history.length).toBe(length)
  },
)

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
const preloadError = (message?: string) => {
  const event = new Event('vite:preloadError', { cancelable: true })
  if (message) Object.defineProperty(event, 'payload', { value: new Error(message) })
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
  finishReveal()
  expect(document.getElementById('boot')).toBeNull()

  document.body.innerHTML = bodyHtml
  installGuard()
  const second = preloadError()
  expect(second.defaultPrevented).toBe(false)
  expect(errorPanelVisible()).toBe(true)
})
it('keeps a spent automatic reload budget until the user explicitly retries', () => {
  sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, String(Date.now() - 120000))
  expect(preloadError().defaultPrevented).toBe(false)
  expect(errorPanelVisible()).toBe(true)
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
    finishReveal()
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

function failEntry() {
  const script = document.createElement('script')
  script.type = 'module'
  script.src = '/assets/main-transition.js'
  document.body.append(script)
  script.dispatchEvent(new Event('error'))
  return script
}

it('waits for the ordinary entry URL to recover after the first reload, then spends its last retry', async () => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response('missing', { status: 404 }))
    .mockResolvedValueOnce(
      new Response('export {}', { headers: { 'content-type': 'application/javascript' } }),
    )
  vi.stubGlobal('fetch', fetchMock)
  const script = failEntry()
  script.dispatchEvent(new Event('error'))
  expect(errorPanelVisible()).toBe(false)
  expect(replace).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(2000)
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(script.src, {
    cache: 'reload',
    signal: expect.any(AbortSignal),
  })
  expect(replace).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(replace).toHaveBeenCalledTimes(1)
  expect(errorPanelVisible()).toBe(false)

  // A fresh document at the same tab keeps the budget, even if its resource still fails.
  document.body.innerHTML = bodyHtml
  installGuard()
  failEntry()
  expect(errorPanelVisible()).toBe(true)
  await vi.advanceTimersByTimeAsync(20000)
  expect(replace).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/assets/'))).toHaveLength(2)
})

it('waits for every failed required resource and does not hide the splash on an early React render', async () => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  let cssAvailable = false
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith('.css')
      ? new Response(cssAvailable ? 'body{}' : 'missing', {
          status: cssAvailable ? 200 : 404,
          headers: { 'content-type': 'text/css; charset=utf-8' },
        })
      : new Response('export {}', { headers: { 'content-type': 'text/javascript' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  failEntry()
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/assets/main-transition.css'
  document.head.append(link)
  try {
    link.dispatchEvent(new Event('error'))
    ready()
    expect(document.getElementById('boot')).not.toBeNull()
    expect(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)).not.toBeNull()
    expect(sessionStorage.getItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    expect(replace).not.toHaveBeenCalled()
    cssAvailable = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  } finally {
    link.remove()
  }
})

it.each([
  { status: 200, mime: 'text/html', body: '<html>fallback</html>' },
  { status: 200, mime: 'application/javascript', body: '' },
  { status: 404, mime: 'application/javascript', body: 'missing' },
])('stops after 20 seconds for an unusable entry response: $status / $mime / $body', async ({
  status,
  mime,
  body,
}) => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  const fetchMock = vi.fn(
    async () => new Response(body, { status, headers: { 'content-type': mime } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  failEntry()
  await vi.advanceTimersByTimeAsync(19999)
  expect(errorPanelVisible()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(errorPanelVisible()).toBe(true)
  expect(replace).not.toHaveBeenCalled()
  const probes = fetchMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(60000)
  expect(fetchMock).toHaveBeenCalledTimes(probes)
})

it('aborts a hung resource probe and still exposes manual recovery within the overall deadline', async () => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}))
  vi.stubGlobal('fetch', fetchMock)
  failEntry()
  await vi.advanceTimersByTimeAsync(7000)
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  expect(errorPanelVisible()).toBe(false)
  await vi.advanceTimersByTimeAsync(13000)
  expect(errorPanelVisible()).toBe(true)
  expect(replace).not.toHaveBeenCalled()
})

it('uses the bounded propagation wait even when the initial render deadline was almost reached', async () => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
  await vi.advanceTimersByTimeAsync(29000)
  failEntry()
  await vi.advanceTimersByTimeAsync(19999)
  expect(errorPanelVisible()).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(errorPanelVisible()).toBe(true)
})

it('ends the propagation wait if the browser goes offline', async () => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  failEntry()
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(errorPanelVisible()).toBe(true)
    expect(replace).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/assets/'))).toBe(false)
  } finally {
    online.mockRestore()
  }
})

it('does not start resource recovery unless its cross-reload budget can be persisted', async () => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  try {
    failEntry()
    await vi.advanceTimersByTimeAsync(20000)
    expect(errorPanelVisible()).toBe(true)
    expect(replace).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/assets/'))).toBe(false)
  } finally {
    setItem.mockRestore()
  }
})

it('never renews automatic recovery just because failures arrive more than a minute apart', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  await vi.advanceTimersByTimeAsync(61000)
  failEntry()
  expect(errorPanelVisible()).toBe(true)
  expect(replace).not.toHaveBeenCalled()

  // Even across documents, old timestamps remain spent until an explicit user retry.
  sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, String(Date.now() - 120000))
  sessionStorage.setItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY, String(Date.now() - 120000))
  document.body.innerHTML = bodyHtml
  installGuard()
  failEntry()
  expect(errorPanelVisible()).toBe(true)
  expect(replace).not.toHaveBeenCalled()
  document.getElementById('boot-retry')!.click()
  expect(replace).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)).toBeNull()
  expect(sessionStorage.getItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)).toBeNull()
})

it('does not renew spent recovery when each document commits a loading screen before a lazy chunk fails', () => {
  sessionStorage.removeItem(PRELOAD_RELOAD_STORAGE_KEY)
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  ready()
  expect(preloadError().defaultPrevented).toBe(true)
  expect(replace).toHaveBeenCalledTimes(1)

  document.body.innerHTML = bodyHtml
  installGuard()
  ready()
  expect(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)).not.toBeNull()
  expect(preloadError().defaultPrevented).toBe(false)
  expect(replace).toHaveBeenCalledTimes(1)
  expect(errorPanelVisible()).toBe(true)
})

function buildChunk(
  fileName: string,
  imports: string[] = [],
  dynamicImports: string[] = [],
): NonNullable<IndexHtmlTransformContext['chunk']> {
  return {
    type: 'chunk',
    fileName,
    preliminaryFileName: fileName,
    name: fileName,
    isEntry: fileName === 'assets/main-transition.js',
    isDynamicEntry: false,
    isImplicitEntry: false,
    facadeModuleId: '/app/index.html',
    moduleIds: [],
    exports: [],
    imports,
    dynamicImports,
    importedBindings: {},
    implicitlyLoadedBefore: [],
    referencedFiles: [],
    modules: {},
    code: '',
    map: null,
    sourcemapFileName: null,
    viteMetadata: { importedCss: new Set<string>(), importedAssets: new Set<string>() },
  }
}

it('probes the built static graph when the entry is 200 but a transitive import is still missing', async () => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  const entry = buildChunk('assets/main-transition.js', ['assets/vendor.js'], ['assets/lazy.js'])
  const vendor = buildChunk('assets/vendor.js', ['assets/shared.js'])
  vendor.viteMetadata?.importedCss.add('assets/vendor.css')
  const shared = buildChunk('assets/shared.js', ['assets/vendor.js'])
  const lazy = buildChunk('assets/lazy.js')
  const html = startupGuardPlugin().transformIndexHtml.handler(sourceHtml, {
    path: '/index.html',
    filename: '/app/index.html',
    chunk: entry,
    bundle: Object.fromEntries(
      [entry, vendor, shared, lazy].map((chunk) => [chunk.fileName, chunk]),
    ),
  })!
  const scriptStart =
    html.indexOf('<script id="startup-guard">') + '<script id="startup-guard">'.length
  installGuard(html.slice(scriptStart, html.indexOf('</script>', scriptStart)))
  let sharedAvailable = false
  const fetchMock = vi.fn(
    async (url: string) =>
      new Response(url.endsWith('.css') ? 'body{}' : 'export {}', {
        status: url.endsWith('/shared.js') && !sharedAvailable ? 404 : 200,
        headers: { 'content-type': url.endsWith('.css') ? 'text/css' : 'application/javascript' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  failEntry()
  await vi.advanceTimersByTimeAsync(2000)
  expect(replace).not.toHaveBeenCalled()
  expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname).sort()).toEqual([
    '/assets/main-transition.js',
    '/assets/shared.js',
    '/assets/vendor.css',
    '/assets/vendor.js',
  ])
  sharedAvailable = true
  await vi.advanceTimersByTimeAsync(2000)
  expect(replace).toHaveBeenCalledTimes(1)
})

it.each([
  true,
  false,
])('keeps one bounded recovery for a stylesheet error followed by its Vite error (recovers: %s)', async (recovers) => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  let available = false
  const fetchMock = vi.fn(
    async () =>
      new Response(available ? 'body{}' : 'missing', {
        status: available ? 200 : 404,
        headers: { 'content-type': 'text/css' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/assets/lazy-canvas.css'
  document.head.append(link)
  try {
    link.dispatchEvent(new Event('error'))
    expect(preloadError(`Unable to preload CSS for ${link.href}`).defaultPrevented).toBe(true)
    expect(errorPanelVisible()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(replace).not.toHaveBeenCalled()
    if (recovers) {
      available = true
      await vi.advanceTimersByTimeAsync(2000)
      expect(replace).toHaveBeenCalledTimes(1)
      expect(errorPanelVisible()).toBe(false)
    } else {
      await vi.advanceTimersByTimeAsync(8000)
      // Duplicate reports must neither cancel the wait nor extend its original deadline.
      expect(
        preloadError('Unable to preload CSS for /assets/lazy-canvas.css').defaultPrevented,
      ).toBe(true)
      await vi.advanceTimersByTimeAsync(10000)
      expect(errorPanelVisible()).toBe(true)
      expect(replace).not.toHaveBeenCalled()
      const requests = fetchMock.mock.calls.length
      await vi.advanceTimersByTimeAsync(60000)
      expect(fetchMock).toHaveBeenCalledTimes(requests)
    }
  } finally {
    link.remove()
  }
})

it.each([
  'Failed to fetch dynamically imported module: /assets/unrelated.js',
  'Unable to preload CSS for /assets/unrelated.css',
])('does not swallow an unrelated preload error during CSS recovery: %s', async (message) => {
  sessionStorage.removeItem(PRELOAD_RESOURCE_RECOVERY_STORAGE_KEY)
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/assets/lazy-canvas.css'
  document.head.append(link)
  try {
    link.dispatchEvent(new Event('error'))
    expect(preloadError(message).defaultPrevented).toBe(false)
    expect(errorPanelVisible()).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(replace).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/assets/'))).toBe(false)
  } finally {
    link.remove()
  }
})
