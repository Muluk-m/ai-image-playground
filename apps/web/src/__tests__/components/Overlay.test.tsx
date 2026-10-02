// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Overlay from '../../components/Overlay'
import ViewportTooltip from '../../components/ViewportTooltip'

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

function render(element: React.ReactElement) {
  act(() => root.render(element))
}

/** Overlay 的容器（fixed inset-0 那个 div） */
function overlayRoot(): HTMLDivElement {
  const el = document.body.querySelector<HTMLDivElement>('[data-no-drag-select]')
  if (!el) throw new Error('overlay not rendered')
  return el
}

describe('Overlay', () => {
  it('portals to document.body even from inside a backdrop-filter ancestor', () => {
    render(
      <div style={{ backdropFilter: 'blur(8px)' }}>
        <Overlay onClose={() => {}}>
          <div data-testid="dialog">content</div>
        </Overlay>
      </div>,
    )
    const overlay = overlayRoot()
    expect(host.contains(overlay)).toBe(false)
    expect(overlay.parentElement).toBe(document.body)
    expect(overlay.textContent).toContain('content')
  })

  it('ESC closes only the topmost overlay', () => {
    const calls: string[] = []
    function Stack() {
      const [outerOpen, setOuterOpen] = useState(true)
      const [innerOpen, setInnerOpen] = useState(true)
      return (
        <>
          {outerOpen && (
            <Overlay
              onClose={() => {
                calls.push('outer')
                setOuterOpen(false)
              }}
            >
              <div>outer</div>
            </Overlay>
          )}
          {innerOpen && (
            <Overlay
              onClose={() => {
                calls.push('inner')
                setInnerOpen(false)
              }}
              tier="raised"
            >
              <div>inner</div>
            </Overlay>
          )}
        </>
      )
    }
    render(<Stack />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(calls).toEqual(['inner'])
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(calls).toEqual(['inner', 'outer'])
  })

  it('backdrop click closes only when the press started on the surface (pointerdown guard)', () => {
    const onClose = vi.fn()
    render(
      <Overlay onClose={onClose}>
        <div data-testid="dialog">content</div>
      </Overlay>,
    )
    const overlay = overlayRoot()
    const dialog = overlay.querySelector('[data-testid="dialog"]')!

    // 划词路径：press 起于内容，释放（click）落在表面 → 不关闭
    act(() => {
      dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).not.toHaveBeenCalled()

    // 正常 backdrop 点击：press 起于表面 → 关闭
    act(() => {
      overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // 上一条用例只能在表面上直接派发事件；真实浏览器里 backdrop 盖住整个表面，
  // 若它可命中则 e.target 永远是 backdrop、pointerdown-guard 永不放行。
  // jsdom 无布局、做不了 hit-test，故在此锁住让命中落到表面的那条属性。
  it('keeps the dim backdrop out of hit-testing', () => {
    render(
      <Overlay onClose={() => {}}>
        <div>content</div>
      </Overlay>,
    )
    const backdrop = overlayRoot().querySelector('.animate-overlay-in')
    expect(backdrop).not.toBeNull()
    expect(backdrop?.className).toContain('pointer-events-none')
  })

  it('lets nested overlays scroll their own content while the page stays locked', () => {
    render(
      <>
        <Overlay onClose={() => {}}>
          <div data-testid="base">base</div>
        </Overlay>
        <Overlay onClose={() => {}} tier="raised">
          <div data-testid="nested">nested</div>
        </Overlay>
      </>,
    )
    const wheel = (target: Element) => {
      const event = new Event('wheel', { bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }

    // 子浮层是 body 下的兄弟 portal，不在基底浮层的边界内 —— 两层的 guard 都必须放行
    expect(wheel(document.body.querySelector('[data-testid="nested"]')!)).toBe(false)
    expect(wheel(document.body.querySelector('[data-testid="base"]')!)).toBe(false)
    // 背景页仍然锁死
    expect(wheel(document.body)).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
  })
  it('dismisses viewport tooltips when an overlay opens', () => {
    render(
      <div>
        <ViewportTooltip visible>layer tooltip</ViewportTooltip>
      </div>,
    )
    expect(document.body.textContent).toContain('layer tooltip')

    render(
      <>
        <div>
          <ViewportTooltip visible>layer tooltip</ViewportTooltip>
        </div>
        <Overlay onClose={() => {}}>
          <div>modal content</div>
        </Overlay>
      </>,
    )

    expect(document.body.textContent).not.toContain('layer tooltip')
  })

  describe('focus', () => {
    // jsdom 不做布局，getClientRects 恒为空；按「全部可见」处理。
    beforeEach(() => {
      vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    })
    afterEach(() => vi.restoreAllMocks())

    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          {open && (
            <Overlay onClose={() => setOpen(false)} label="对话框">
              <button type="button">first</button>
              <button type="button" onClick={() => setOpen(false)}>
                last
              </button>
            </Overlay>
          )}
        </>
      )
    }

    it('names itself, moves focus inside, wraps Tab and returns focus on close', () => {
      render(<Harness />)
      const opener = host.querySelector('button') as HTMLButtonElement
      opener.focus()
      act(() => opener.click())

      const surface = overlayRoot()
      expect(surface.getAttribute('role')).toBe('dialog')
      expect(surface.getAttribute('aria-modal')).toBe('true')
      expect(surface.getAttribute('aria-label')).toBe('对话框')
      expect(document.activeElement?.textContent).toBe('first')

      const last = [...surface.querySelectorAll('button')].find((b) => b.textContent === 'last')!
      last.focus()
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
      })
      expect(document.activeElement?.textContent).toBe('first')

      act(() => last.click())
      expect(document.activeElement).toBe(opener)
    })

    it('leaves the dialog role to content that declares its own', () => {
      render(
        <Overlay onClose={() => {}} role="none">
          <div role="dialog" aria-label="inner">
            <button type="button">ok</button>
          </div>
        </Overlay>,
      )
      expect(overlayRoot().hasAttribute('role')).toBe(false)
    })
  })
})
