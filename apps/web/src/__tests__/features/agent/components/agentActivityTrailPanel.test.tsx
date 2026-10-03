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
  it('shows only the step that is running now', () => {
    render()
    act(() =>
      useAgentStore.setState({
        messages: [
          { ...step('t1', 'readCanvas', '看画布'), status: 'succeeded' } as AgentPanelMessage,
          step('t2', 'viewImage', '看图：4 张'),
        ],
      }),
    )
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    expect(log.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(1)
    expect(log.textContent).toContain('看图：4 张')
    expect(log.textContent).not.toContain('看画布')
    expect(log.querySelector('[data-agent-message-id="t2"] [data-slot="tool-call"]')).not.toBeNull()
  })

  it('folds finished steps into one line that expands on demand', () => {
    const done = (id: string, title: string) =>
      ({ ...step(id, 'viewImage', title), status: 'succeeded' }) as AgentToolMessage
    act(() =>
      root.render(
        <AgentActivityTrail
          steps={[done('t1', '看画布'), done('t2', '看图：1 张')]}
          spent={true}
        />,
      ),
    )
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.textContent).toBe('已完成 2 步')
    expect(host.querySelector('[data-slot="tool-call"]')).toBeNull()
    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelectorAll('[data-slot="tool-call"]')).toHaveLength(2)
  })

  it('expands a folded trail when search locates one of its steps', () => {
    const done = (id: string) =>
      ({ ...step(id, 'viewImage', id), status: 'succeeded' }) as AgentToolMessage
    act(() =>
      root.render(
        <AgentActivityTrail steps={[done('t1'), done('t2')]} spent={true} revealId="t2" />,
      ),
    )
    expect(host.querySelector('[data-agent-message-id="t2"]')).not.toBeNull()
  })

  it('keeps a single completed tool call inspectable after the assistant replies', () => {
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
})
