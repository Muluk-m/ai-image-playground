// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MultiSceneHint } from '../../../components/creation/MultiSceneHint'
import { useStore } from '../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MATCHING = '给我 6 个不同场景的产品图'
const GRID = '做成宫格，6 个不同场景'

let host: HTMLDivElement
let root: Root

function mount(node: ReactNode): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(node))
}

function rerender(node: ReactNode): void {
  act(() => root.render(node))
}

function hint(): HTMLElement | null {
  return host.querySelector('[data-testid="multi-scene-hint"]')
}

beforeEach(() => {
  useStore.setState({ prompt: MATCHING, createTarget: 'generate' })
  mount(<MultiSceneHint prompt={MATCHING} imageCount={1} creationMode="image" />)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('MultiSceneHint', () => {
  it('renders the n=1 hint with the requested count and an agent link', () => {
    const el = hint()
    expect(el).not.toBeNull()
    expect(el?.textContent).toContain('当前会出 1 张图')
    expect(el?.textContent).toContain('想要 6 个不同场景')
    expect(el?.textContent).toContain('请分别写 6 条提示词')
    expect(el?.textContent).not.toContain('画面会比较接近')
    const link = el?.querySelector('button.creation-multi-scene-hint-agent')
    expect(link?.textContent).toBe('交给智能体')
  })

  it('does not render when n is greater than 1', () => {
    rerender(<MultiSceneHint prompt={MATCHING} imageCount={6} creationMode="image" />)
    expect(hint()).toBeNull()
  })

  it('does not render in agent mode', () => {
    rerender(<MultiSceneHint prompt={MATCHING} imageCount={1} creationMode="agent" />)
    expect(hint()).toBeNull()
  })

  it('does not render for a grid or collage prompt', () => {
    rerender(<MultiSceneHint prompt={GRID} imageCount={1} creationMode="image" />)
    expect(hint()).toBeNull()
  })

  it('dismisses for that prompt and comes back when the text changes', () => {
    const close = host.querySelector<HTMLButtonElement>(
      '[data-testid="multi-scene-hint"] button[aria-label="关闭"]',
    )
    expect(close).not.toBeNull()
    act(() => close?.click())
    expect(hint()).toBeNull()

    rerender(<MultiSceneHint prompt={MATCHING} imageCount={1} creationMode="image" />)
    expect(hint()).toBeNull()

    rerender(<MultiSceneHint prompt="请做 4 张不同的海报" imageCount={1} creationMode="image" />)
    expect(hint()?.textContent).toContain('想要 4 个不同场景')
  })

  it('handing to the agent switches mode and keeps the prompt', () => {
    const link = host.querySelector<HTMLButtonElement>('button.creation-multi-scene-hint-agent')
    act(() => link?.click())
    expect(useStore.getState().createTarget).toBe('chat')
    expect(useStore.getState().prompt).toBe(MATCHING)
  })
})
