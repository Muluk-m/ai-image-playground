// @vitest-environment jsdom
import { act, Component, createElement, type JSX, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELOAD_QUERY_PARAM } from '../../boot/constants'
import RouteChunkBoundary, { RouteLoading } from '../../components/RouteChunkBoundary'

class ParentBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    return this.state.error ? (
      <p role="parent-error">{this.state.error.message}</p>
    ) : (
      this.props.children
    )
  }
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('RouteChunkBoundary', () => {
  it('keeps the route shell content while a lazy page loads', () => {
    act(() => root.render(createElement(RouteLoading, { label: 'Opening page…' })))
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Opening page…')
  })

  it('recovers the child when retry clears the route failure', () => {
    let shouldThrow = true
    const onRetry = vi.fn(() => {
      shouldThrow = false
    })
    function BrokenPage(): JSX.Element {
      if (shouldThrow) throw new Error('Failed to fetch dynamically imported module')
      return <p>Page recovered</p>
    }
    const boundary = createElement(RouteChunkBoundary, {
      title: 'Page unavailable',
      description: 'Try again',
      retryLabel: 'Reload',
      onRetry,
      children: createElement(BrokenPage),
    })
    act(() => root.render(boundary))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Page unavailable')
    act(() => host.querySelector('button')?.click())
    expect(onRetry).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).toContain('Page recovered')
  })

  it('resets a failed boundary when the route key changes', () => {
    const props = {
      title: 'Page unavailable',
      description: 'Try again',
      retryLabel: 'Reload',
    }
    function BrokenPage(): JSX.Element {
      throw new Error('Failed to fetch dynamically imported module')
    }
    act(() =>
      root.render(
        createElement(RouteChunkBoundary, {
          ...props,
          key: 'assets',
          children: createElement(BrokenPage),
        }),
      ),
    )
    expect(host.querySelector('[role="alert"]')).not.toBeNull()

    act(() =>
      root.render(
        createElement(RouteChunkBoundary, {
          ...props,
          key: 'explore',
          children: createElement('p', null, 'Explore opened'),
        }),
      ),
    )
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).toContain('Explore opened')
  })

  it('shows recovery UI for Safari chunk failures', () => {
    function BrokenPage(): JSX.Element {
      throw new Error('Load failed')
    }
    act(() =>
      root.render(
        createElement(RouteChunkBoundary, {
          title: 'Page unavailable',
          description: 'Try again',
          retryLabel: 'Reload',
          children: createElement(BrokenPage),
        }),
      ),
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Page unavailable')
  })

  it('hard-reloads the same URL when the user clicks 重新加载', () => {
    const replace = vi.fn()
    vi.stubGlobal('location', {
      href: 'https://muvloom.online/p/project?mode=canvas#selection',
      replace,
    })
    function BrokenPage(): JSX.Element {
      throw new Error('Failed to fetch dynamically imported module: /assets/App.js')
    }
    act(() =>
      root.render(
        createElement(RouteChunkBoundary, {
          title: '页面暂时无法打开',
          description: '资源加载失败',
          retryLabel: '重新加载',
          children: createElement(BrokenPage),
        }),
      ),
    )
    act(() => host.querySelector('button')?.click())
    const next = new URL(replace.mock.calls[0]![0] as string)
    expect(next.pathname).toBe('/p/project')
    expect(next.searchParams.get('mode')).toBe('canvas')
    expect(next.hash).toBe('#selection')
    expect(next.searchParams.has(RELOAD_QUERY_PARAM)).toBe(true)
    vi.unstubAllGlobals()
  })

  it('passes non-chunk errors to the parent boundary', () => {
    function BrokenPage(): JSX.Element {
      throw new Error('canvas render failed')
    }
    act(() =>
      root.render(
        createElement(ParentBoundary, {
          children: createElement(RouteChunkBoundary, {
            title: 'Page unavailable',
            description: 'Try again',
            retryLabel: 'Reload',
            children: createElement(BrokenPage),
          }),
        }),
      ),
    )
    expect(host.querySelector('[role="parent-error"]')?.textContent).toBe('canvas render failed')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})
