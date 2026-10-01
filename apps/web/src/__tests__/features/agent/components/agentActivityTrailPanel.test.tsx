// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentActivityTrail from '../../../../features/agent/components/AgentActivityTrail'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { useAgentStore } from '../../../../features/agent/store'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'
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

describe('inspectable read-only tools', () => {
  it('uses assistant-ui ToolCall for viewImage and readCanvas', () => {
    render()
    act(() =>
      useAgentStore.setState({
        messages: [step('t1', 'readCanvas', '看画布'), step('t2', 'viewImage', '看图：4 张')],
      }),
    )
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    expect(log.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(2)
    expect(log.textContent).toContain('看图：4 张')
    expect(log.querySelector('[data-agent-message-id="t2"] [data-slot="tool-call"]')).not.toBeNull()
  })

  it('keeps completed tool calls inspectable after the assistant replies', () => {
    const done = {
      ...step('t1', 'viewImage', '看图：1 张'),
      status: 'succeeded',
    } as AgentToolMessage
    act(() => root.render(<AgentActivityTrail steps={[done]} spent={true} />))
    const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-slot="tool-call"]')).not.toBeNull()
  })

  it('retains search sources and failure actions in tool components', () => {
    const done = {
      ...step('t1', 'webSearch', '搜索'),
      status: 'succeeded',
      sources: [{ title: 'Source', url: 'https://example.com/one' }],
    } as AgentToolMessage
    const failed = {
      ...step('t2', 'webFetch', '读取网页'),
      status: 'failed',
      errorCode: 'timeout',
    } as AgentToolMessage
    act(() => root.render(<AgentActivityTrail steps={[done, failed]} spent={false} />))
    expect(host.querySelector('a[href="https://example.com/one"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="tool-error"]')).not.toBeNull()
  })

  it('助手回复后仍保留每次联网读取失败的原因和处理入口', () => {
    render()
    act(() =>
      useAgentStore.setState({
        messages: [
          {
            ...step('t1', 'webSearch', '搜索：小米手机'),
            status: 'succeeded',
          } as AgentPanelMessage,
          {
            ...step('t2', 'webFetch', '读取网页：www.mi.com'),
            status: 'failed',
            errorCode: 'source_unavailable',
          } as AgentPanelMessage,
          {
            ...step('t3', 'webFetch', '读取网页：www.mi.com'),
            status: 'failed',
            errorCode: 'source_unavailable',
          } as AgentPanelMessage,
          {
            kind: 'text',
            id: 'r1',
            turnId: 'turn-1',
            role: 'assistant',
            text: '我换一个来源',
          } as AgentPanelMessage,
        ],
      }),
    )
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    const failures = log.querySelectorAll('[data-slot="tool-error"]')
    expect(failures).toHaveLength(2)
    for (const failure of failures) {
      expect(failure.textContent).toContain('读取网页：www.mi.com')
      expect(failure.textContent).toContain('来源网站拒绝或无法提供内容，请换个公开来源')
      expect(
        Array.from(failure.querySelectorAll('button')).some(
          (button) => button.textContent === '让助手重新处理',
        ),
      ).toBe(true)
    }
    expect(log.textContent).toContain('我换一个来源')
  })
})
