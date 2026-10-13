// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreationReferenceStack } from '../../components/creation/CreationReferenceStack'
import { REFERENCE_DISPLAY_KEY } from '../../components/creation/referenceDisplay'
import { Button } from '../../components/ui/button'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback()
    return 0
  })
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
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
  act(() => host.querySelector<HTMLButtonElement>('.creation-reference-heading button')!.click())
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
  act(() => host.querySelector<HTMLButtonElement>('.creation-reference-heading button')!.click())
  expect(host.querySelectorAll('.creation-reference-panel')).toHaveLength(0)
  act(() => root.render(null))
  act(() => root.render(fixture))
  expect(host.querySelector('.creation-reference-panel')).toBeNull()
  localStorage.setItem(REFERENCE_DISPLAY_KEY, 'true')
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: REFERENCE_DISPLAY_KEY })))
  expect(host.querySelector('.creation-reference-panel')).not.toBeNull()
})
