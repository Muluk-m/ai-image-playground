// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import TaskCard from '../../components/TaskCard'
import { ActualValueBadge } from '../../lib/paramDisplay'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const host = document.createElement('div')
document.body.append(host)
let root = createRoot(host)
afterEach(() => {
  act(() => root.unmount())
  root = createRoot(host)
})

const task = {
  id: 't1',
  prompt: '一只橘猫',
  params: { ...DEFAULT_PARAMS, size: '1024x1024', n: 2 },
  apiModel: 'gemini-3.1-flash-lite-image',
  maskImageId: 'mask-1',
  transparentOutput: true,
  // 实际尺寸比例不同，走 ActualValueBadge 那条分支。
  actualParams: { size: '1536x1024' },
  inputImageIds: [],
  outputImages: [],
  status: 'done',
  error: null,
  createdAt: Date.now() - 60_000,
  finishedAt: Date.now() - 50_000,
  elapsed: 9000,
} as unknown as TaskRecord

it('keeps every tag inside the card: tags may shrink to the row width and truncate their text', () => {
  const noop = () => {}
  act(() =>
    root.render(
      <TaskCard
        task={task}
        onReuse={noop}
        onEditOutputs={noop}
        onSendToCanvas={noop}
        onDelete={noop}
        onClick={noop}
      />,
    ),
  )
  const row = host.querySelector('[data-tag-scroll-area]')
  const tags = [...(row?.children ?? [])]
  expect(tags.length).toBeGreaterThanOrEqual(5)
  for (const tag of tags) {
    // flex-shrink-0 曾让「Nano Banana 2 Lite」比卡片右栏还宽时直接顶出卡片。
    expect(tag.className).not.toContain('flex-shrink-0')
    expect(tag.className).toContain('min-w-0')
    expect(tag.className).toContain('max-w-full')
    expect(tag.querySelector('.truncate')).not.toBeNull()
  }
  // 名字被省略时悬停仍能看到全名。
  expect(tags[0].getAttribute('title')).toBeTruthy()
})

it('详情弹窗用的 ActualValueBadge 不截断，多行 revised prompt 能完整显示', () => {
  act(() =>
    root.render(<ActualValueBadge value={'第一行\n第二行'} className="whitespace-pre-wrap" />),
  )
  expect(host.querySelector('.truncate')).toBeNull()
  expect(host.textContent).toContain('第二行')
})

it('被取消的任务显示「已取消」，不显示红色「失败」', () => {
  const noop = () => {}
  act(() =>
    root.render(
      <TaskCard
        task={{ ...task, status: 'error', cancelled: true, error: 'BFF 任务被取消' }}
        onReuse={noop}
        onEditOutputs={noop}
        onSendToCanvas={noop}
        onDelete={noop}
        onClick={noop}
      />,
    ),
  )
  expect(host.textContent).toContain('已取消')
  expect(host.textContent).not.toContain('失败')
})
