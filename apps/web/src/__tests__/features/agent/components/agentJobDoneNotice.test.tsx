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
const selectConversation = vi.fn(async (_id: string) => {})

beforeEach(() => {
  resetAgentJobActivity()
  selectConversation.mockClear()
  useAgentStore.setState({ selectConversation })
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

it('对话外出完图时弹提示，查看回到那段对话（BUG-16）', () => {
  expect(host.querySelector('[data-agent-job-notice]')).toBeNull()
  act(() =>
    useAgentJobActivity.setState({
      activity: {
        'conv-1': { running: 0, done: { conversationId: 'conv-1', images: 4, failed: 0, at: 1 } },
      },
      notice: { conversationId: 'conv-1', images: 4, failed: 0, at: 1 },
    }),
  )
  const notice = host.querySelector('[data-agent-job-notice]')
  expect(notice?.textContent).toContain('生成完成')
  expect(notice?.textContent).toContain('「咖啡海报」4 张图已生成')

  const view = [...host.querySelectorAll('button')].find((one) => one.textContent === '查看')!
  act(() => view.click())
  expect(selectConversation).toHaveBeenCalledWith('conv-1')
  expect(useStore.getState().appMode).toBe('canvas')
  expect(useAgentJobActivity.getState().notice).toBeNull()
  expect(useAgentJobActivity.getState().activity['conv-1']).toBeUndefined()
})

it('有没完成的说清几张没完成；不理它会自己收起', () => {
  vi.useFakeTimers()
  act(() =>
    useAgentJobActivity.setState({
      notice: { conversationId: 'conv-x', images: 2, failed: 1, at: 1 },
    }),
  )
  expect(host.textContent).toContain('「新对话」生成结束：2 张已生成，1 张没有完成')
  act(() => vi.advanceTimersByTime(12_000))
  expect(host.querySelector('[data-agent-job-notice]')).toBeNull()
})

it('可以手动关掉', () => {
  act(() =>
    useAgentJobActivity.setState({
      notice: { conversationId: 'conv-1', images: 1, failed: 0, at: 1 },
    }),
  )
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!.click())
  expect(host.querySelector('[data-agent-job-notice]')).toBeNull()
})
