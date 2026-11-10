// @vitest-environment jsdom
import { act, Component, type ReactNode, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BUILD_META_NAME,
  PRELOAD_RELOAD_STORAGE_KEY,
  RELOAD_QUERY_PARAM,
} from '../../boot/constants'
import { isChunkFailure, lazyWithReload, reloadOnceForChunkFailure } from '../../lib/chunkLoad'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const replace = vi.fn()
const missing = () =>
  new TypeError('Failed to fetch dynamically imported module: /assets/App-old.js')

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  render() {
    return this.state.error ? <p>boundary</p> : this.props.children
  }
}

let host: HTMLDivElement
let root: Root

async function mount(load: () => Promise<{ default: () => ReactNode }>) {
  const Lazy = lazyWithReload(load)
  await act(async () => {
    root.render(
      <Boundary>
        <Suspense fallback={<p>loading</p>}>
          <Lazy />
        </Suspense>
      </Boundary>,
    )
  })
  // Let the rejected import settle and React commit the result.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  replace.mockClear()
  sessionStorage.clear()
  vi.stubGlobal('location', { href: 'https://app.test/workbench?tab=1#node', replace })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

it('recognizes module download failures but not a bare Safari fetch failure', () => {
  expect(isChunkFailure(missing())).toBe(true)
  expect(isChunkFailure(new TypeError('Importing a module script failed.'))).toBe(true)
  expect(isChunkFailure(new Error('Unable to preload CSS for /assets/App-old.css'))).toBe(true)
  expect(isChunkFailure(new TypeError('Load failed'))).toBe(false)
  expect(isChunkFailure(new Error('boom'))).toBe(false)
})

it('reloads once per HTML build and keeps path, query and hash', () => {
  expect(reloadOnceForChunkFailure()).toBe(true)
  const target = new URL(replace.mock.calls[0][0])
  expect(target.pathname).toBe('/workbench')
  expect(target.searchParams.get('tab')).toBe('1')
  expect(target.searchParams.has(RELOAD_QUERY_PARAM)).toBe(true)
  expect(target.hash).toBe('#node')
  expect(reloadOnceForChunkFailure()).toBe(false)
  expect(replace).toHaveBeenCalledTimes(1)
})

it('spends the budget per HTML build: a newer build may reload once more', () => {
  const meta = document.createElement('meta')
  meta.name = BUILD_META_NAME
  meta.content = 'build-a'
  document.head.append(meta)
  try {
    sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, `${Date.now()}|build-a`)
    expect(reloadOnceForChunkFailure()).toBe(false)
    meta.content = 'build-b'
    expect(reloadOnceForChunkFailure()).toBe(true)
    expect(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)).toMatch(/\|build-b$/)
    expect(reloadOnceForChunkFailure()).toBe(false)
    expect(replace).toHaveBeenCalledTimes(1)
  } finally {
    meta.remove()
  }
})

it('reloads instead of surfacing a missing chunk', async () => {
  await mount(() => Promise.reject(missing()))
  expect(replace).toHaveBeenCalledTimes(1)
  expect(host.textContent).toBe('loading')
})

it('hands the failure to the boundary once the reload budget is spent', async () => {
  sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, `${Date.now()}|`)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await mount(() => Promise.reject(missing()))
  expect(host.textContent).toBe('boundary')
  expect(replace).not.toHaveBeenCalled()
})

it('does not reload for ordinary module errors', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await mount(() => Promise.reject(new Error('module threw')))
  expect(host.textContent).toBe('boundary')
  expect(replace).not.toHaveBeenCalled()
})
