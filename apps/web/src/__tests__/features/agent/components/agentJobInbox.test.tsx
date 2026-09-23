// @vitest-environment jsdom
import type { AgentBackgroundJobProgress, AgentToolArtifact } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentJobInbox from '../../../../features/agent/components/AgentJobInbox'
import { type AgentCanvasSink, setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { useAgentStore } from '../../../../features/agent/store'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'

/** 取消走 store 的那个动作；这里只要看见它被叫到，真去取消是后台任务 module 的事。 */
const cancelJob = vi.fn(async (_messageId: string) => {})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const IMAGE: AgentToolArtifact = {
  artifactId: 'agent_image_1',
  media: 'image',
  taskId: 'task-2',
  outputIndex: 0,
  mime: 'image/png',
}

function job(id: string, patch: Partial<AgentToolMessage>): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId: 'turn-1',
    toolCallId: `call-${id}`,
    title: `任务 ${id}`,
    status: 'submitted',
    job: { taskId: `task-${id}`, media: 'image' },
    ...patch,
  }
}

const focus = vi.fn()
const focusPending = vi.fn(() => true)
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  useAgentStore.setState({ messages: [], jobProgress: {}, toolStartedAt: {}, cancelJob })
  cancelJob.mockClear()
  focus.mockClear()
  focusPending.mockClear()
  focusPending.mockImplementation(() => true)
  setAgentCanvasSink({ focus, focusPending } as unknown as AgentCanvasSink)
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  setAgentCanvasSink(null)
})

function render() {
  act(() => root.render(<AgentJobInbox />))
}

function rowButton(title: string): HTMLButtonElement {
  return [...host.querySelectorAll('li button')].find((one) =>
    one.textContent?.includes(title),
  ) as HTMLButtonElement
}

it('stays out of the way when the conversation has no background jobs', () => {
  useAgentStore.setState({
    messages: [
      {
        kind: 'text',
        id: 'u',
        turnId: 'turn-1',
        role: 'user',
        text: '你好',
        streaming: false,
      },
      // 同步的调用（局部改图等）没有后台任务，不进收件箱。
      job('sync', { status: 'succeeded', job: undefined }),
    ],
  })
  render()
  expect(host.textContent).toBe('')
})

function openInbox() {
  act(() => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click())
}

function tabButton(label: string): HTMLButtonElement {
  return [...host.querySelectorAll('[role="tab"]')].find((one) =>
    one.textContent?.startsWith(label),
  ) as HTMLButtonElement
}

it('shows how far the batch got and groups the running jobs by what they are doing', () => {
  useAgentStore.setState({
    messages: [
      job('1', {}),
      job('2', { status: 'succeeded', artifacts: [IMAGE] }),
      job('3', { status: 'failed', errorCode: 'cancelled' }),
      job('4', {}),
    ],
  })
  useAgentStore.setState({
    jobProgress: { '1': { stage: 'running', submittedAt: Date.now() - 5_000 } },
  })
  render()

  const summary = host.querySelector('button[aria-expanded]')!
  // 入口上只有标题与「走完几个」，进度条与逐个任务在点开的弹层里；一句话留给读屏与悬停。
  expect(summary.textContent).toContain('生成任务')
  expect(summary.textContent).toContain('2/4')
  expect(summary.getAttribute('aria-label')).toBe('2 个进行中 · 1 个已完成 · 1 个没有完成')
  expect(host.querySelector('span[style]')).toBeNull()
  expect(host.querySelector('li')).toBeNull()

  openInbox()
  const [done, failed] = [...host.querySelectorAll('span[style]')].map(
    (one) => (one as HTMLElement).style.width,
  )
  expect([done, failed]).toEqual(['25%', '25%'])
  expect(tabButton('进行中').textContent).toBe('进行中（2）')
  expect(tabButton('已完成').textContent).toBe('已完成（2）')

  // 进行中这一页分两组：上游真在画的与还等着的。
  const groups = [...host.querySelectorAll('button[aria-expanded]')]
    .map((one) => one.textContent ?? '')
    .filter((text) => text.includes('（'))
  expect(groups).toEqual(['处理中（1）', '排队中（1）'])
  const running = [...host.querySelectorAll('li')].map((one) => one.textContent)
  expect(running[0]).toContain('任务 1')
  expect(running[0]).toMatch(/生成中 · 已用 0:0[5-6]/)
  expect(running[1]).toContain('任务 4')
  expect(running[1]).toContain('已提交')

  // 结束的在另一页，按新到旧。
  act(() => tabButton('已完成').click())
  const finished = [...host.querySelectorAll('li')].map((one) => one.textContent)
  expect(finished[0]).toContain('任务 3')
  expect(finished[0]).toContain('已取消')
  expect(finished[1]).toContain('任务 2')
  expect(finished[1]).toContain('已完成')
})

it('collapses a group in place', () => {
  useAgentStore.setState({ messages: [job('1', {}), job('2', {})] })
  render()
  openInbox()
  expect(host.querySelectorAll('li')).toHaveLength(2)

  const queued = [...host.querySelectorAll('button[aria-expanded]')].find((one) =>
    one.textContent?.startsWith('排队中'),
  ) as HTMLButtonElement
  act(() => queued.click())
  expect(host.querySelector('li')).toBeNull()
})

it('counts a job still waiting in the retry queue as running, not as finished', () => {
  // 重试队列里排着的那张还没拿到任务 id；算成已结束，顶上就会在还有活儿时说全干完了。
  useAgentStore.setState({
    messages: [
      job('1', { status: 'succeeded', artifacts: [IMAGE] }),
      job('2', { status: 'queued', job: undefined }),
    ],
  })
  render()

  const summary = host.querySelector('button[aria-expanded]')!
  expect(summary.textContent).toContain('1/2')
  expect(summary.getAttribute('aria-label')).toBe('1 个进行中 · 1 个已完成')

  openInbox()
  expect(rowButton('任务 2').textContent).toContain('排队中')
})

it('locates a running job by its placeholder and a finished one by its artifacts', () => {
  useAgentStore.setState({
    messages: [job('1', {}), job('2', { status: 'succeeded', artifacts: [IMAGE] })],
  })
  render()
  openInbox()

  act(() => rowButton('任务 1').click())
  expect(focusPending).toHaveBeenCalledWith({ messageId: '1', taskId: 'task-1' })
  expect(focus).not.toHaveBeenCalled()
  // 镜头已经带过去了，弹层就让开画布。
  expect(host.querySelector('li')).toBeNull()

  openInbox()
  act(() => tabButton('已完成').click())
  act(() => rowButton('任务 2').click())
  expect(focus).toHaveBeenCalledWith(['agent_image_1'])
})

it('falls back to the anchor object when a running job has no placeholder after a refresh', () => {
  // 本地项目刷新或换设备后，在跑的任务要等交付才重新占位。
  focusPending.mockImplementation(() => false)
  useAgentStore.setState({ messages: [job('1', { anchorObjectId: 'source-image' }), job('2', {})] })
  // 服务端刚重启，执行器在重新接上上游：行里说的是重连，不是排队。
  useAgentStore.setState({
    jobProgress: {
      '1': { stage: 'submitted', submittedAt: Date.now(), phase: 'reconnecting' },
    },
  })
  render()
  openInbox()
  expect(rowButton('任务 1').textContent).toContain('重新连接中')

  act(() => rowButton('任务 1').click())
  expect(focusPending).toHaveBeenCalledWith({ messageId: '1', taskId: 'task-1' })
  expect(focus).toHaveBeenCalledWith(['source-image'])

  // 没有占位也没有锚点：没有可去的地方，镜头不动。
  focus.mockClear()
  openInbox()
  act(() => rowButton('任务 2').click())
  expect(focus).not.toHaveBeenCalled()
})

it('cancels a single running job from its row', async () => {
  useAgentStore.setState({
    messages: [job('1', {}), job('2', { status: 'succeeded', artifacts: [IMAGE] })],
  })
  render()
  act(() => (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click())

  const cancels = [...host.querySelectorAll('button')].filter(
    (one) => one.textContent === '取消任务',
  )
  // 只有在跑的那一个能取消。
  expect(cancels).toHaveLength(1)
  await act(async () => cancels[0]!.click())
  expect(cancelJob).toHaveBeenCalledWith('1')
})
