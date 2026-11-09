// @vitest-environment jsdom
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RouteChunkBoundary, { RouteLoading } from '../../components/RouteChunkBoundary'

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

  it('shows a retry action after a route chunk fails and retries the child', () => {
    const onRetry = vi.fn()
    function BrokenPage(): JSX.Element {
      throw new Error('chunk failed')
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
  })
})
