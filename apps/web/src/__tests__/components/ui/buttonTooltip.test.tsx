// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Hint } from '../../../components/ui/tooltip'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(() => {
  act(() => root.unmount())
  root = createRoot(host)
})

it('shows the action label on focus and updates it without remounting the button', async () => {
  act(() =>
    root.render(
      <Button size="icon" aria-label="编辑素材">
        <Icon name="edit" />
      </Button>,
    ),
  )
  const button = host.querySelector('button')!
  await act(async () => button.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('编辑素材')
  await act(async () =>
    root.render(
      <Button size="icon" aria-label="保存素材">
        <Icon name="edit" />
      </Button>,
    ),
  )
  expect(host.querySelector('button')).toBe(button)
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('保存素材')
  await act(async () =>
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('keeps one tooltip when an existing Hint supplies a more detailed label', async () => {
  act(() =>
    root.render(
      <Hint tooltip="编辑素材名称">
        <Button size="icon" aria-label="编辑素材">
          <Icon name="edit" />
        </Button>
      </Hint>,
    ),
  )
  await act(async () => host.querySelector('button')!.focus())
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('编辑素材名称')
})

it('keeps icon action labels inside a card with its own preview hint', async () => {
  act(() =>
    root.render(
      <Hint tooltip="图片预览">
        <div>
          <Button size="icon" aria-label="添加遮罩">
            <Icon name="edit" />
          </Button>
        </div>
      </Hint>,
    ),
  )
  await act(async () => host.querySelector('button')!.focus())
  expect(
    Array.from(document.querySelectorAll('[role="tooltip"]')).some(
      (tooltip) => tooltip.textContent === '添加遮罩',
    ),
  ).toBe(true)
})
