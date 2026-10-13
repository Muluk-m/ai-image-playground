// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreationReferenceStack } from '../../components/creation/CreationReferenceStack'
import { REFERENCE_DISPLAY_KEY } from '../../components/creation/referenceDisplay'
import { Button } from '../../components/ui/button'
import { pointer, stubPointerApis } from '../helpers/radix'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback()
    return 0
  })
  stubPointerApis()
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('expands inline, preserves adding and removal, and remembers collapse', () => {
  const add = vi.fn()
  function Fixture() {
    const [count, setCount] = useState(100)
    return (
      <CreationReferenceStack count={count} previews={[]} add={<Button onClick={add}>添加</Button>}>
        <Button data-remove onClick={() => setCount(count - 1)}>
          移除一张
        </Button>
      </CreationReferenceStack>
    )
  }
  act(() => root.render(<Fixture />))
  expect(host.querySelector('.creation-reference-panel')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('.creation-stack-expand')!.click())
  expect(host.querySelector('.creation-reference-panel')).not.toBeNull()
  expect(localStorage.getItem(REFERENCE_DISPLAY_KEY)).toBe('true')
  act(() => host.querySelector<HTMLButtonElement>('[data-remove]')!.click())
  expect(host.querySelector('.creation-reference-heading')!.textContent).toContain('99')
  act(() => host.querySelector<HTMLButtonElement>('.creation-stack-add button')!.click())
  expect(add).toHaveBeenCalledOnce()
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起参考图"]')!.click())
  expect(host.querySelector('.creation-reference-panel')).toBeNull()
  expect(localStorage.getItem(REFERENCE_DISPLAY_KEY)).toBe('false')
})

it('restores the view after remount and synchronizes mounted composers and other tabs', () => {
  const fixture = (
    <CreationReferenceStack count={2} previews={[]} add={<Button>添加</Button>}>
      <span>图片</span>
    </CreationReferenceStack>
  )
  localStorage.setItem(REFERENCE_DISPLAY_KEY, 'true')
  act(() =>
    root.render(
      <>
        {fixture}
        {fixture}
      </>,
    ),
  )
  expect(host.querySelectorAll('.creation-reference-panel')).toHaveLength(2)
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起参考图"]')!.click())
  expect(host.querySelectorAll('.creation-reference-panel')).toHaveLength(0)
  act(() => root.render(null))
  act(() => root.render(fixture))
  expect(host.querySelector('.creation-reference-panel')).toBeNull()
  localStorage.setItem(REFERENCE_DISPLAY_KEY, 'true')
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: REFERENCE_DISPLAY_KEY })))
  expect(host.querySelector('.creation-reference-panel')).not.toBeNull()
})

it('opens on hover without saving, supports quick removal, and closes after leaving', () => {
  vi.useFakeTimers()
  const remove = vi.fn()
  act(() =>
    root.render(
      <CreationReferenceStack count={2} previews={[]} add={<Button>添加</Button>}>
        <Button onClick={remove} data-remove>
          移除一张
        </Button>
      </CreationReferenceStack>,
    ),
  )
  act(() => host.querySelector('.creation-stack-trigger')!.dispatchEvent(pointer('pointerover')))
  expect(host.querySelector('.creation-reference-panel')).not.toBeNull()
  expect(localStorage.getItem(REFERENCE_DISPLAY_KEY)).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('[data-remove]')!.click())
  expect(remove).toHaveBeenCalledOnce()
  act(() => host.querySelector('.creation-reference-stack')!.dispatchEvent(pointer('pointerout')))
  act(() => vi.advanceTimersByTime(210))
  expect(host.querySelector('.creation-reference-panel')).toBeNull()
})

it('only offers view all for multiple images and clears every reference', () => {
  function Fixture() {
    const [count, setCount] = useState(2)
    return (
      <CreationReferenceStack
        count={count}
        previews={[]}
        add={<Button>添加</Button>}
        onClear={() => setCount(0)}
      >
        <Button onClick={() => setCount(1)} data-remove>
          移除一张
        </Button>
      </CreationReferenceStack>
    )
  }
  act(() => root.render(<Fixture />))
  expect(host.querySelector('.creation-stack-expand')).not.toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('.creation-stack-trigger')!.click())
  act(() => host.querySelector<HTMLButtonElement>('[data-remove]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起参考图"]')!.click())
  expect(host.querySelector('.creation-stack-expand')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('.creation-stack-trigger')!.click())
  act(() =>
    Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === '清空参考素材')!
      .click(),
  )
  expect(host.querySelector('.creation-reference-panel')).toBeNull()
  expect(host.querySelector('.creation-stack-trigger')).toBeNull()
  expect(host.querySelector('.creation-stack-add')).not.toBeNull()
})

it('keeps hover references mounted while a portalled menu is active, then closes', () => {
  vi.useFakeTimers()
  act(() =>
    root.render(
      <CreationReferenceStack count={2} previews={[]} add={<Button>添加</Button>}>
        <span>参考</span>
      </CreationReferenceStack>,
    ),
  )
  act(() => host.querySelector('.creation-stack-trigger')!.dispatchEvent(pointer('pointerover')))
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.tabIndex = -1
  document.body.append(menu)
  menu.focus()
  act(() => host.querySelector('.creation-reference-stack')!.dispatchEvent(pointer('pointerout')))
  act(() => vi.advanceTimersByTime(500))
  expect(host.querySelector('.creation-reference-panel')).not.toBeNull()
  menu.remove()
  act(() => vi.advanceTimersByTime(210))
  expect(host.querySelector('.creation-reference-panel')).toBeNull()
})
