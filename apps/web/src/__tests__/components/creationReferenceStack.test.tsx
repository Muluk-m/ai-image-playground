// @vitest-environment jsdom
import { act, useState } from 'react'
import { createPortal } from 'react-dom'
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
  expect(document.querySelector('.creation-reference-panel')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('.creation-stack-expand')!.click())
  expect(document.querySelector('.creation-reference-panel')).not.toBeNull()
  expect(localStorage.getItem(REFERENCE_DISPLAY_KEY)).toBe('true')
  act(() => document.querySelector<HTMLButtonElement>('[data-remove]')!.click())
  expect(host.querySelector('.creation-reference-heading')!.textContent).toContain('99')
  act(() => host.querySelector<HTMLButtonElement>('.creation-stack-add button')!.click())
  expect(add).toHaveBeenCalledOnce()
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起参考图"]')!.click())
  expect(document.querySelector('.creation-reference-panel')).toBeNull()
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
  expect(document.querySelector('.creation-reference-panel')).toBeNull()
  localStorage.setItem(REFERENCE_DISPLAY_KEY, 'true')
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: REFERENCE_DISPLAY_KEY })))
  expect(document.querySelector('.creation-reference-panel')).not.toBeNull()
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
  expect(document.querySelector('.creation-reference-panel')).not.toBeNull()
  expect(localStorage.getItem(REFERENCE_DISPLAY_KEY)).toBeNull()
  act(() => document.querySelector<HTMLButtonElement>('[data-remove]')!.click())
  expect(remove).toHaveBeenCalledOnce()
  act(() => host.querySelector('.creation-reference-stack')!.dispatchEvent(pointer('pointerout')))
  act(() => vi.advanceTimersByTime(210))
  expect(document.querySelector('.creation-reference-panel')).toBeNull()
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
  act(() => document.querySelector<HTMLButtonElement>('[data-remove]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起参考图"]')!.click())
  expect(host.querySelector('.creation-stack-expand')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('.creation-stack-trigger')!.click())
  act(() =>
    Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === '清空参考素材')!
      .click(),
  )
  expect(document.querySelector('.creation-reference-panel')).toBeNull()
  expect(host.querySelector('.creation-stack-trigger')).toBeNull()
  expect(host.querySelector('.creation-stack-add')).not.toBeNull()
})

it('keeps its own portalled menu mounted, without retaining unrelated menus', () => {
  vi.useFakeTimers()
  const menu = (
    <div role="menu">
      <Button role="menuitem">菜单操作</Button>
    </div>
  )
  act(() =>
    root.render(
      <CreationReferenceStack count={2} previews={[]} add={<Button>添加</Button>}>
        {createPortal(menu, document.body)}
      </CreationReferenceStack>,
    ),
  )
  act(() => host.querySelector('.creation-stack-trigger')!.dispatchEvent(pointer('pointerover')))
  act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.focus())
  act(() => host.querySelector('.creation-reference-stack')!.dispatchEvent(pointer('pointerout')))
  act(() => vi.advanceTimersByTime(500))
  expect(document.querySelector('.creation-reference-panel')).not.toBeNull()
  const unrelated = document.createElement('button')
  unrelated.setAttribute('role', 'menuitem')
  document.body.append(unrelated)
  act(() => unrelated.focus())
  act(() => vi.advanceTimersByTime(210))
  expect(document.querySelector('.creation-reference-panel')).toBeNull()
  unrelated.remove()
})

it('keeps a stable focused single-image trigger so hover then click pins the panel', () => {
  act(() =>
    root.render(
      <CreationReferenceStack count={1} previews={[]} add={<Button>添加</Button>}>
        <span>图片</span>
      </CreationReferenceStack>,
    ),
  )
  const trigger = host.querySelector<HTMLButtonElement>('.creation-stack-trigger')!
  act(() => trigger.focus())
  act(() => trigger.dispatchEvent(pointer('pointerover')))
  expect(trigger.isConnected).toBe(true)
  expect(document.activeElement).toBe(trigger)
  act(() => trigger.click())
  expect(localStorage.getItem(REFERENCE_DISPLAY_KEY)).toBe('true')
  expect(host.querySelector('.creation-reference-panel')).not.toBeNull()
})

it('does not close when an action focuses the editor while the pointer stays over references', () => {
  vi.useFakeTimers()
  const editor = document.createElement('textarea')
  document.body.append(editor)
  act(() =>
    root.render(
      <CreationReferenceStack count={2} previews={[]} add={<Button>添加</Button>}>
        <Button data-remove onClick={() => editor.focus()}>
          插入引用
        </Button>
      </CreationReferenceStack>,
    ),
  )
  act(() => host.querySelector('.creation-stack-trigger')!.dispatchEvent(pointer('pointerover')))
  const action = document.querySelector<HTMLButtonElement>('[data-remove]')!
  act(() => action.focus())
  act(() => action.click())
  act(() => vi.advanceTimersByTime(500))
  expect(document.querySelector('.creation-reference-panel')).not.toBeNull()
  act(() => host.querySelector('.creation-reference-stack')!.dispatchEvent(pointer('pointerout')))
  act(() => vi.advanceTimersByTime(210))
  expect(document.querySelector('.creation-reference-panel')).toBeNull()
  editor.remove()
})
