// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CreationReferenceStack } from '../../components/creation/CreationReferenceStack'
import { Button } from '../../components/ui/button'
import { stubPointerApis } from '../helpers/radix'

it('keeps bulk references behind one stack and preserves individual removal and adding', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubPointerApis()
  const add = vi.fn()
  function Fixture() {
    const [count, setCount] = useState(100)
    return (
      <CreationReferenceStack
        count={count}
        previews={[<span key="a">A</span>, <span key="b">B</span>, <span key="c">C</span>]}
        add={<Button onClick={add}>添加</Button>}
      >
        <Button onClick={() => setCount(count - 1)}>移除一张</Button>
      </CreationReferenceStack>
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<Fixture />))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.creation-stack-trigger')!.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('移除一张')
    act(() => dialog.querySelector<HTMLButtonElement>('button')!.click())
    expect(host.querySelector('.creation-stack-trigger')!.getAttribute('aria-label')).toContain(
      '99',
    )
    act(() => host.querySelector<HTMLButtonElement>('.creation-stack-add button')!.click())
    expect(add).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
