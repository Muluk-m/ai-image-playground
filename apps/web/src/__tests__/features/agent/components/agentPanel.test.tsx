// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MANIFEST = {
  'accounts:login': false,
  'accounts:self-register': false,
  'accounts:sync': false,
  'agent:chat': true,
  'billing:credits': false,
  'generation:byok': true,
  'generation:storyboard': false,
  'generation:video': false,
  'matte:server': false,
  'quota:daily': false,
  'remix:analyze': false,
  'remix:listing': false,
}

let host: HTMLDivElement
let root: Root

async function enableAgent(enabled: boolean): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...MANIFEST, 'agent:chat': enabled })),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  vi.unstubAllGlobals()
}

function render(): void {
  act(() => {
    root.render(<AgentPanel doc={new CanvasDoc()} />)
  })
}

function texts(selector: string): string[] {
  return [...host.querySelectorAll(selector)].map((node) => node.textContent ?? '')
}

beforeEach(async () => {
  await enableAgent(true)
  useAgentStore.setState({
    open: true,
    tab: 'chat',
    conversationId: null,
    messages: [],
    turn: 'idle',
    error: null,
    loaded: true,
    expanded: {},
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('AgentPanel', () => {
  it('渲染对话与图层两个页签', () => {
    render()

    expect(texts('button')).toContain('对话')
    expect(texts('button')).toContain('图层')
  })

  it('切到图层页签显示画布对象', () => {
    render()
    const layers = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '图层',
    )!
    act(() => layers.click())

    expect(host.textContent).toContain('画布还是空的')
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('收起后只留一个重新打开的入口', () => {
    render()
    const collapse = host.querySelector('button[aria-label="收起面板"]') as HTMLButtonElement
    act(() => collapse.click())

    expect(host.querySelector('textarea')).toBeNull()
    expect(texts('button')).toEqual(['对话'])
  })

  it('助手回复带展开入口，展开后收起', () => {
    useAgentStore.setState({
      messages: [
        { id: 'assistant-1', role: 'assistant', text: '好'.repeat(400), streaming: false },
      ],
    })
    render()
    // jsdom 不排版，折叠判定量不出溢出；直接从展开态验证入口的两个状态。
    act(() => useAgentStore.getState().toggleExpanded('assistant-1'))

    expect(texts('button')).toContain('收起')
    act(() => useAgentStore.getState().toggleExpanded('assistant-1'))
    expect(texts('button')).not.toContain('收起')
  })

  it('能力关闭时什么都不渲染', async () => {
    await enableAgent(false)
    render()

    expect(host.innerHTML).toBe('')
  })
})
