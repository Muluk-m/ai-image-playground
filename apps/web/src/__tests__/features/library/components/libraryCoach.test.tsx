// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LibraryCoach from '../../../../features/library/components/LibraryCoach'
import { useLibraryStore } from '../../../../features/library/store'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  useStore.setState({
    tasks: [],
    inspirationCoachDismissed: true,
    libraryCoachDismissed: false,
    libraryPanelOpened: false,
  })
  useLibraryStore.setState({ openPanel: vi.fn() })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function render() {
  act(() => root.render(<LibraryCoach />))
}

function findButton(label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))
  if (!button) throw new Error(`no button labelled ${label}`)
  return button
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the library coach card', () => {
  it('walks the four steps', () => {
    render()

    const text = host.textContent ?? ''
    expect(text).toContain('存为素材')
    expect(text).toContain('@')
    expect(text).toContain('{槽位}')
    expect(text).toContain('/')
  })

  it('goes away for good once dismissed', () => {
    render()

    click(findButton('知道了'))

    expect(useStore.getState().libraryCoachDismissed).toBe(true)
    expect(host.textContent).toBe('')
  })

  it('opens the panel from 看看', () => {
    render()

    click(findButton('看看'))

    expect(useLibraryStore.getState().openPanel).toHaveBeenCalled()
    expect(useStore.getState().libraryCoachDismissed).toBe(true)
  })

  it('stays away while the inspiration coach still has the floor', () => {
    useStore.setState({ inspirationCoachDismissed: false, tasks: [] })
    render()

    expect(host.textContent).toBe('')
  })

  it('stays away once the panel has been opened', () => {
    useStore.setState({ libraryPanelOpened: true })
    render()

    expect(host.textContent).toBe('')
  })

  it('stays away after a reload that restored the dismissal', () => {
    useStore.setState({ libraryCoachDismissed: true })
    render()

    expect(host.textContent).toBe('')
  })
})
