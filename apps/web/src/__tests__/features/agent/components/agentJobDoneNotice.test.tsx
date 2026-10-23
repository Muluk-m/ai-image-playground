// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentJobDoneNotice from '../../../../features/agent/components/AgentJobDoneNotice'
import {
  resetAgentJobActivity,
  useAgentJobActivity,
} from '../../../../features/agent/lib/jobActivity'
import { useAgentStore } from '../../../../features/agent/store'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
// 和真的一样：切过去了才把 conversationId 换成它。
const selectConversation = vi.fn(async (id: string) => {
  useAgentStore.setState({ conversationId: id })
})

beforeEach(() => {
  resetAgentJobActivity()
  selectConversation.mockClear()
  useAgentStore.setState({ selectConversation, conversationId: null })
  useStore.setState({ appMode: 'image' })
  useCanvasProjectStore.setState({
    projects: [
      {
        id: 'p-1',
        name: '咖啡海报',
        customName: true,
        conversationId: 'conv-1',
        sceneKey: 'p-1',
        createdAt: 1,
        updatedAt: 1,
        hasContent: true,
        kind: 'image',
        experience: 'chat',
      },
    ],
    loaded: true,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<AgentJobDoneNotice />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('对话外出完图时弹提示，查看回到那段对话（BUG-16）', async () => {
  expect(host.querySelector('[data-agent-job-notice]')).toBeNull()
  act(() =>
    useAgentJobActivity.setState({
      activity: {
        'conv-1': {
          running: 0,
          done: { conversationId: 'conv-1', images: 4, videos: 0, failed: 0, at: 1 },
        },
      },
      notice: { conversationId: 'conv-1', images: 4, videos: 0, failed: 0, at: 1 },
    }),
  )
  const notice = host.querySelector('[data-agent-job-notice]')
  expect(notice?.textContent).toContain('生成完成')
  expect(notice?.textContent).toContain('「咖啡海报」4 张图已生成')

  const view = [...host.querySelectorAll('button')].find((one) => one.textContent === '查看')!
  await act(async () => view.click())
  expect(selectConversation).toHaveBeenCalledWith('conv-1')
  expect(useStore.getState().appMode).toBe('canvas')
  expect(useAgentJobActivity.getState().notice).toBeNull()
  expect(useAgentJobActivity.getState().activity['conv-1']).toBeUndefined()
})

it('有没完成的说清几张没完成；不理它会自己收起', () => {
  vi.useFakeTimers()
  act(() =>
    useAgentJobActivity.setState({
      notice: { conversationId: 'conv-x', images: 2, videos: 0, failed: 1, at: 1 },
    }),
  )
  expect(host.textContent).toContain('「新对话」生成结束：2 张图已生成，1 项没有完成')
  act(() => vi.advanceTimersByTime(12_000))
  expect(host.querySelector('[data-agent-job-notice]')).toBeNull()
})

it('可以手动关掉', () => {
  act(() =>
    useAgentJobActivity.setState({
      notice: { conversationId: 'conv-1', images: 1, videos: 0, failed: 0, at: 1 },
    }),
  )
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!.click())
  expect(host.querySelector('[data-agent-job-notice]')).toBeNull()
})

it('查看没切过去（别的对话这一轮还在跑）就把提示留着（Codex P2）', async () => {
  selectConversation.mockImplementationOnce(async () => {})
  act(() =>
    useAgentJobActivity.setState({
      activity: {
        'conv-1': {
          running: 0,
          done: { conversationId: 'conv-1', images: 4, videos: 0, failed: 0, at: 1 },
        },
      },
      notice: { conversationId: 'conv-1', images: 4, videos: 0, failed: 0, at: 1 },
    }),
  )
  const view = [...host.querySelectorAll('button')].find((one) => one.textContent === '查看')!
  await act(async () => view.click())
  expect(selectConversation).toHaveBeenCalledWith('conv-1')
  expect(useAgentJobActivity.getState().notice?.conversationId).toBe('conv-1')
  expect(useAgentJobActivity.getState().activity['conv-1']?.done).toBeDefined()
  expect(host.querySelector('[data-agent-job-notice]')).not.toBeNull()
})

it('出的是视频就说「个视频」，不说成「张图」（Codex P2）', () => {
  act(() =>
    useAgentJobActivity.setState({
      notice: { conversationId: 'conv-1', images: 0, videos: 2, failed: 0, at: 1 },
    }),
  )
  expect(host.textContent).toContain('「咖啡海报」2 个视频已生成')
  expect(host.textContent).not.toContain('张图')
  act(() =>
    useAgentJobActivity.setState({
      notice: { conversationId: 'conv-1', images: 3, videos: 1, failed: 0, at: 2 },
    }),
  )
  expect(host.textContent).toContain('「咖啡海报」3 张图、1 个视频已生成')
})

it('查看时加载出错也不抛到外面，提示留着（复审 P1）', async () => {
  selectConversation.mockImplementationOnce(async () => {
    throw new Error('load failed')
  })
  act(() =>
    useAgentJobActivity.setState({
      notice: { conversationId: 'conv-1', images: 1, videos: 0, failed: 0, at: 1 },
    }),
  )
  const view = [...host.querySelectorAll('button')].find((one) => one.textContent === '查看')!
  await act(async () => view.click())
  expect(useAgentJobActivity.getState().notice?.conversationId).toBe('conv-1')
})

it('提示在通知层，不会被作品预览这类浮层盖住（复审 P1）', () => {
  expect(host.querySelector('[role="status"]')?.parentElement?.className).toContain('z-[1390]')
})
