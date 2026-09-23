// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { useAgentStore } from '../../../../features/agent/store'
import type { AgentPanelMessage } from '../../../../features/agent/types'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const step = (id: string, toolName: string, title: string): AgentPanelMessage =>
  ({
    kind: 'tool',
    id,
    turnId: 'turn-1',
    toolCallId: `call-${id}`,
    toolName,
    title,
    status: 'running',
  }) as AgentPanelMessage

beforeEach(async () => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ 'agent:chat': true, 'generation:byok': true })),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  vi.unstubAllGlobals()
  host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(): void {
  act(() => {
    const editor = { scrollToElements: () => {} } as unknown as CanvasEditor
    root.render(<AgentPanel doc={new CanvasDoc()} editor={editor} />)
  })
}

/**
 * 只读步骤折进活动轨之后，**面板上必须还看得见它们**。折叠与隐藏只差一步：
 * 分类把它们从结果卡里摘出来，渲染那头要是没接上，对话里就整段空白，
 * 用户会以为智能体什么都没做。
 */
describe('AgentPanel 活动轨', () => {
  it('把正在跑的只读步骤显示在对话里', () => {
    render()
    act(() =>
      useAgentStore.setState({
        messages: [step('t1', 'readCanvas', '看画布'), step('t2', 'viewImage', '看图：4 张')],
      }),
    )
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    expect(log.textContent).toContain('看画布')
    expect(log.textContent).toContain('看图：4 张')
  })

  it('保持显示到这一轮真的跑完，不被同一批事件里的后续消息提前收掉', () => {
    render()
    act(() =>
      useAgentStore.setState({
        messages: [
          step('t1', 'readCanvas', '看画布'),
          {
            kind: 'text',
            id: 'r1',
            turnId: 'turn-1',
            role: 'assistant',
            text: '先看看',
          } as AgentPanelMessage,
        ],
      }),
    )
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    // 这一步还在跑，后面即使已经有助手文字也不能收——收了整段过程一帧都看不到。
    expect(log.textContent).toContain('看画布')
  })

  it('步骤都跑完、模型开始给结论后把过程收掉', () => {
    render()
    act(() =>
      useAgentStore.setState({
        messages: [
          { ...step('t1', 'readCanvas', '看画布'), status: 'succeeded' } as AgentPanelMessage,
          {
            kind: 'text',
            id: 'r1',
            turnId: 'turn-1',
            role: 'assistant',
            text: '画布上有五个对象',
          } as AgentPanelMessage,
        ],
      }),
    )
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    expect(log.textContent).toContain('画布上有五个对象')
    // 收起走的是高度动画，动画期间节点还在；判据是它已经不占地方、也看不见。
    const trail = log.querySelector<HTMLElement>('output[aria-live="polite"]')!
    expect(trail.style.height).toBe('0px')
    expect(trail.style.opacity).toBe('0')
  })
})
