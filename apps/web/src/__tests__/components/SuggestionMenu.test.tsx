// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SuggestionMenu, {
  type SuggestionMenuOption,
  useSuggestionMenu,
} from '../../components/SuggestionMenu'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
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
  document.body.innerHTML = ''
})

const OPTIONS: SuggestionMenuOption<number>[] = [
  { key: 'a', label: '@图1', thumbnailUrl: 'data:image/png;base64,a', value: 0 },
  { key: 'b', label: '@图2', thumbnailUrl: 'data:image/png;base64,b', value: 1 },
  { key: 'c', label: '@图3', thumbnailUrl: 'data:image/png;base64,c', value: 2 },
]

function Harness({
  options = OPTIONS,
  onSelect,
  onClose = () => {},
}: {
  options?: SuggestionMenuOption<number>[]
  onSelect: (value: number) => void
  onClose?: () => void
}) {
  const menu = useSuggestionMenu({ options, onSelect, onClose })
  return (
    <div data-testid="editor" onKeyDown={menu.handleKeyDown}>
      {menu.visible && (
        <SuggestionMenu
          heading="选择当前参考图"
          options={options}
          activeIndex={menu.activeIndex}
          offsetLeft={0}
          onActiveIndexChange={menu.setActiveIndex}
          onSelect={menu.select}
        />
      )}
    </div>
  )
}

function editor() {
  const el = host.querySelector<HTMLDivElement>('[data-testid="editor"]')
  if (!el) throw new Error('harness not rendered')
  return el
}

function optionButtons() {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'))
}

function activeLabel() {
  return optionButtons()
    .find((button) => button.getAttribute('aria-selected') === 'true')
    ?.textContent?.trim()
}

function pressKey(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    editor().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

describe('SuggestionMenu', () => {
  it('renders every candidate and highlights the first one', () => {
    act(() => root.render(<Harness onSelect={() => {}} />))

    expect(optionButtons().map((button) => button.textContent?.trim())).toEqual([
      '@图1',
      '@图2',
      '@图3',
    ])
    expect(activeLabel()).toBe('@图1')
  })

  it('moves the highlight with the arrow keys and wraps around', () => {
    act(() => root.render(<Harness onSelect={() => {}} />))

    pressKey('ArrowDown')
    expect(activeLabel()).toBe('@图2')

    pressKey('ArrowUp')
    pressKey('ArrowUp')
    expect(activeLabel()).toBe('@图3')
  })

  it('selects the highlighted candidate on Enter', () => {
    const onSelect = vi.fn()
    act(() => root.render(<Harness onSelect={onSelect} />))

    pressKey('ArrowDown')
    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('selects and closes on click', () => {
    const onSelect = vi.fn()
    act(() => root.render(<Harness onSelect={onSelect} />))

    act(() => {
      optionButtons()[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(onSelect).toHaveBeenCalledWith(2)
    expect(optionButtons()).toHaveLength(0)
  })

  it('leaves Shift+Enter to the editor and hands Escape back to the caller', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    act(() => root.render(<Harness onSelect={onSelect} onClose={onClose} />))

    pressKey('Enter', { shiftKey: true })
    expect(onSelect).not.toHaveBeenCalled()

    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays hidden when there is no candidate', () => {
    act(() => root.render(<Harness options={[]} onSelect={() => {}} />))

    expect(optionButtons()).toHaveLength(0)
  })
})
