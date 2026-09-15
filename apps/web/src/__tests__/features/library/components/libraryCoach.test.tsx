// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LibraryCoach, { useLibraryCoach } from '../../../../features/library/components/LibraryCoach'
import { assetStore } from '../../../../features/library/lib/assetStore'
import { templateStore } from '../../../../features/library/lib/templateStore'
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
  localStorage.clear()
  vi.spyOn(assetStore, 'list').mockResolvedValue([])
  vi.spyOn(templateStore, 'list').mockResolvedValue([])
  useStore.setState({
    tasks: [],
    inspirationCoachDismissed: true,
    libraryCoachDismissed: false,
    libraryPanelOpened: false,
  })
  useLibraryStore.setState({ panelOpen: false })
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

function CoachHost() {
  const { active, dismiss } = useLibraryCoach()
  return active ? <LibraryCoach onDismiss={dismiss} /> : null
}

function render() {
  act(() =>
    root.render(
      <StrictMode>
        <CoachHost />
      </StrictMode>,
    ),
  )
}

async function reload() {
  const { storage, name } = useStore.persist.getOptions()
  if (!storage || !name) throw new Error('store persistence is not configured')
  const saved = await storage.getItem(name)
  if (!saved) throw new Error('store state was not persisted')
  act(() => root.unmount())
  useStore.setState({ libraryCoachDismissed: false, libraryPanelOpened: false })
  await storage.setItem(name, saved)
  await useStore.persist.rehydrate()
  root = createRoot(host)
  render()
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
  it('does not return on reload even when neither coach button was clicked', async () => {
    render()
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()

    await reload()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('can be dismissed immediately and stays dismissed after reload', async () => {
    render()

    click(findButton('知道了'))

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await reload()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens the library and closes the coach from 看看', async () => {
    render()

    await act(async () => click(findButton('看看')))

    expect(useLibraryStore.getState().panelOpen).toBe(true)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not consume its appearance until the inspiration coach gives way', async () => {
    useStore.setState({ inspirationCoachDismissed: false, tasks: [] })
    render()
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    await reload()
    act(() => useStore.getState().dismissInspirationCoach())
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()

    await reload()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('stays away once the panel has been opened', () => {
    useStore.setState({ libraryPanelOpened: true })
    render()

    expect(host.textContent).toBe('')
  })

  it('closes when the library is opened from another entry point', async () => {
    render()

    await act(async () => useLibraryStore.getState().openPanel())
    act(() => useLibraryStore.getState().closePanel())

    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })
})
