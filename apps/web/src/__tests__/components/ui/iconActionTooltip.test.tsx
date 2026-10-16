// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { Hint } from '../../../components/ui/tooltip'
import AgentIconButton from '../../../features/agent/components/AgentIconButton'
import CanvasToolbarButton from '../../../features/canvas/components/CanvasToolbarButton'
import { NodeTool } from '../../../features/canvas/components/NodeCanvasToolbar'

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

const actions: [IconName, string][] = [
  ['copy', '复制'],
  ['edit', '编辑'],
  ['delete', '删除'],
  ['download', '下载'],
  ['attach', '添加附件'],
  ['favorite', '收藏'],
  ['refresh', '重试'],
  ['add', '添加'],
  ['more', '更多'],
  ['undo', '撤销'],
  ['redo', '重做'],
  ['zoomIn', '放大'],
  ['zoomOut', '缩小'],
  ['chevronRight', '下一页'],
  ['play', '播放'],
  ['send', '发送'],
  ['pause', '暂停'],
  ['fullscreen', '全屏'],
]

it.each(
  actions,
)('omits redundant %s labels through automatic and explicit tooltip paths', async (name, label) => {
  act(() =>
    root.render(
      <>
        <Button aria-label={label} title={label}>
          <Icon name={name} />
        </Button>
        <Hint tooltip={label}>
          <Button aria-label={label}>
            <Icon name={name} />
          </Button>
        </Hint>
        <TooltipIconButton tooltip={label}>
          <Icon name={name} />
        </TooltipIconButton>
      </>,
    ),
  )
  for (const button of host.querySelectorAll('button')) {
    await act(async () => button.focus())
    expect(button.getAttribute('aria-label')).toBe(label)
    expect(button.hasAttribute('title')).toBe(false)
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  }
})

it('applies the same policy to Agent and both canvas toolbars without losing actions', async () => {
  const action = vi.fn()
  act(() =>
    root.render(
      <>
        <AgentIconButton icon="copy" label="复制" onClick={action} />
        <NodeTool icon="undo" label="撤销" onClick={action} />
        <CanvasToolbarButton compact icon={<Icon name="delete" />} label="删除" onClick={action} />
      </>,
    ),
  )
  for (const button of host.querySelectorAll('button')) {
    await act(async () => button.focus())
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => button.click())
  }
  expect(action).toHaveBeenCalledTimes(3)
})

it('retains unfamiliar actions and disabled reasons, including changes on a focused button', async () => {
  const action = vi.fn()
  const render = (reason?: string) => (
    <CanvasToolbarButton
      compact
      icon={<Icon name="delete" />}
      label="删除"
      reason={reason}
      onClick={action}
    />
  )
  act(() => root.render(render()))
  const button = host.querySelector('button')!
  await act(async () => button.focus())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => root.render(render('请先移除关联')))
  expect(host.querySelector('button')).toBe(button)
  expect(document.activeElement).toBe(button)
  expect(button.getAttribute('aria-description')).toBe('请先移除关联')
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('请先移除关联')
  await act(async () => button.click())
  expect(action).not.toHaveBeenCalled()
  await act(async () =>
    root.render(
      <TooltipIconButton tooltip="复用生成参数">
        <Icon name="reuse" />
      </TooltipIconButton>,
    ),
  )
  await act(async () => host.querySelector('button')!.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('复用生成参数')
})

it('retains upload limits separate from the accessible action and non-button previews', async () => {
  act(() =>
    root.render(
      <>
        <Button aria-label="添加参考图" title="最多 10 张，每张 20 MB">
          <Icon name="add" />
        </Button>
        <Hint tooltip="参考图预览">
          <span tabIndex={0}>
            <Icon name="image" />
          </span>
        </Hint>
      </>,
    ),
  )
  await act(async () => host.querySelector('button')!.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('最多 10 张，每张 20 MB')
  await act(async () => host.querySelector<HTMLElement>('span[tabindex]')!.focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('参考图预览')
})

it('retains counts and nonstandard uses of familiar action shapes', async () => {
  act(() =>
    root.render(
      <>
        <AgentIconButton
          icon="refresh"
          label="重试"
          aria-description="重试剩下的 3 张"
          onClick={() => {}}
        />
        <CanvasToolbarButton
          compact
          icon={<Icon name="download" />}
          label="下载"
          description="导出 2 张"
          onClick={() => {}}
        />
        <Button aria-label="对调首尾帧">
          <Icon name="replace" />
        </Button>
      </>,
    ),
  )
  const buttons = host.querySelectorAll('button')
  for (const [index, text] of ['重试剩下的 3 张', '导出 2 张', '对调首尾帧'].entries()) {
    await act(async () => buttons[index].focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(text)
  }
})
