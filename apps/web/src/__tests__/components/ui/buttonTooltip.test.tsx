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

it('preserves focus when a conditional title appears and disappears', async () => {
  const render = (title?: string) => <Button title={title}>保存</Button>
  act(() => root.render(render()))
  const button = host.querySelector('button')!
  await act(async () => button.focus())
  for (const title of ['已保存', undefined]) {
    await act(async () => root.render(render(title)))
    expect(host.querySelector('button')).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(title)
  }
})

it('preserves an asChild link when its label appears and disappears', async () => {
  const render = (label?: string) => (
    <Button asChild aria-label={label}>
      <a href="#details">详情</a>
    </Button>
  )
  act(() => root.render(render()))
  const link = host.querySelector('a')!
  await act(async () => link.focus())
  for (const label of ['查看详情', undefined]) {
    await act(async () => root.render(render(label)))
    expect(host.querySelector('a')).toBe(link)
    expect(document.activeElement).toBe(link)
    expect(link.getAttribute('aria-label')).toBe(label ?? null)
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  }
})

it('does not turn a visible label into a tooltip', async () => {
  act(() =>
    root.render(
      <>
        <Button aria-label="编辑">编辑</Button>
        <Button size="icon" aria-label="关闭">
          <Icon name="close" />
        </Button>
      </>,
    ),
  )
  const buttons = host.querySelectorAll('button')
  await act(async () => buttons[0].focus())
  expect(buttons[0].getAttribute('aria-label')).toBe('编辑')
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => buttons[1].focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('关闭')
})

it('lets an intermediary trigger own the disabled reason and normal action label', async () => {
  const render = (blocked: boolean) => (
    <Hint tooltip={blocked ? '请先添加参考图' : '生成图片'}>
      <span tabIndex={0}>
        <Button autoTooltip={false} disabled={blocked} aria-label="生成图片">
          生成
        </Button>
      </span>
    </Hint>
  )
  act(() => root.render(render(true)))
  await act(async () => host.querySelector('span')!.focus())
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('请先添加参考图')
  await act(async () => root.render(render(false)))
  await act(async () => host.querySelector('button')!.focus())
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('生成图片')
})

it('closes the previous tooltip across independent providers', async () => {
  act(() =>
    root.render(
      <>
        <Button size="icon" aria-label="编辑">
          <Icon name="edit" />
        </Button>
        <Button size="icon" aria-label="保存">
          <Icon name="close" />
        </Button>
      </>,
    ),
  )
  const buttons = host.querySelectorAll('button')
  await act(async () => buttons[0].focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('编辑')
  await act(async () => buttons[1].focus())
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('保存')
})
