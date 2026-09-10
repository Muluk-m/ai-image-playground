// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { useLibraryStore } from '../../../../features/library/store'
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
  // 输入框要素材名做胶囊标签，jsdom 里没有 IndexedDB 可读。
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
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
  setAgentCanvasSink(null)
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
        {
          kind: 'text',
          id: 'assistant-1',
          role: 'assistant',
          text: '好'.repeat(400),
          streaming: false,
        },
      ],
    })
    render()
    // jsdom 不排版，折叠判定量不出溢出；直接从展开态验证入口的两个状态。
    act(() => useAgentStore.getState().toggleExpanded('assistant-1'))

    expect(texts('button')).toContain('收起')
    act(() => useAgentStore.getState().toggleExpanded('assistant-1'))
    expect(texts('button')).not.toContain('收起')
  })

  it('结果卡上的缩略图点一下定位到画布上的同一个对象', async () => {
    const focused: string[] = []
    setAgentCanvasSink({
      has: () => true,
      revision: () => 0,
      async place() {
        return 'placed'
      },
      focus: (imageId) => focused.push(imageId),
      async thumbnail() {
        return 'data:image/png;base64,AQID'
      },
    })
    useAgentStore.setState({
      messages: [
        {
          kind: 'tool',
          id: 'tool-1',
          toolCallId: 'call-1',
          title: '一只橘猫坐在窗台上',
          status: 'succeeded',
          images: [
            { imageId: 'agent_image_1', taskId: 'task-1', outputIndex: 0, mime: 'image/png' },
          ],
        },
      ],
    })
    render()
    // 缩略图是画布异步渲出来的，等它落进 DOM。
    await act(async () => {
      await Promise.resolve()
    })

    expect(host.textContent).toContain('一只橘猫坐在窗台上')
    const thumbnail = host.querySelector('img')!.closest('button') as HTMLButtonElement
    act(() => thumbnail.click())

    expect(focused).toEqual(['agent_image_1'])
  })

  it('画布冲突的结果卡写清没有自动写入，点一下手动放入', async () => {
    const placeOnCanvas = vi.fn(async () => {})
    useAgentStore.setState({
      placeOnCanvas,
      messages: [
        {
          kind: 'tool',
          id: 'tool-1',
          toolCallId: 'call-1',
          title: '一只橘猫坐在窗台上',
          status: 'succeeded',
          canvasConflict: true,
          images: [
            { imageId: 'agent_image_1', taskId: 'task-1', outputIndex: 0, mime: 'image/png' },
          ],
        },
      ],
    })
    render()

    expect(host.textContent).toContain('生成期间画布有改动，本次结果没有自动写入画布。')
    const place = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '放入画布',
    )!
    act(() => place.click())

    expect(placeOnCanvas).toHaveBeenCalledWith('tool-1')
  })

  it('能力关闭时什么都不渲染', async () => {
    await enableAgent(false)
    render()

    expect(host.innerHTML).toBe('')
  })
})
