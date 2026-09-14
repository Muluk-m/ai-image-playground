// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { useLibraryStore } from '../../../../features/library/store'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

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
    // 面板只把 editor 转交给图层页签；这些用例不点图层，给个空壳就够。
    const editor = { scrollToElements: () => {} } as unknown as CanvasEditor
    root.render(<AgentPanel doc={new CanvasDoc()} editor={editor} />)
  })
}

function texts(selector: string): string[] {
  return [...host.querySelectorAll(selector)].map((node) => node.textContent ?? '')
}

beforeEach(async () => {
  await enableAgent(true)
  // 输入框要素材名做胶囊标签，jsdom 里没有 IndexedDB 可读。
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  useAgentStore.getState().startNewConversation()
  useAgentStore.setState({
    open: true,
    tab: 'chat',
    conversationId: null,
    messages: [],
    turns: {},
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
          turnId: 'turn-1',
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

  it('产物真正落画布后才显示可定位缩略图，不必重新挂载面板', async () => {
    const focused: string[] = []
    setAgentCanvasSink({
      has: () => true,
      revision: () => 0,
      async place() {
        return 'placed'
      },
      focus: (objectId) => focused.push(objectId),
      async thumbnail() {
        return 'data:image/png;base64,AQID'
      },
    })
    useAgentStore.setState({
      messages: [
        {
          kind: 'tool',
          id: 'tool-1',
          turnId: 'turn-1',
          toolCallId: 'call-1',
          title: '一只橘猫坐在窗台上',
          status: 'succeeded',
          delivery: 'pending',
          artifacts: [
            {
              artifactId: 'agent_image_1',
              media: 'image',
              taskId: 'task-1',
              outputIndex: 0,
              mime: 'image/png',
            },
          ],
        },
      ],
    })
    render()
    // 缩略图是画布异步渲出来的，等它落进 DOM。
    await act(async () => {
      await Promise.resolve()
    })
    expect(host.querySelector('img')).toBeNull()
    await act(async () => {
      useAgentStore.setState((state) => ({
        messages: state.messages.map((message) =>
          message.kind === 'tool' ? { ...message, delivery: 'placed' } : message,
        ),
      }))
      await Promise.resolve()
    })

    expect(host.textContent).toContain('一只橘猫坐在窗台上')
    const thumbnail = host.querySelector('img')!.closest('button') as HTMLButtonElement
    act(() => thumbnail.click())

    expect(focused).toEqual(['agent_image_1'])
  })

  it('手动交付把冲突产物放入画布，并用可定位的缩略图替换入口', async () => {
    const onCanvas = new Set<string>()
    setAgentCanvasSink({
      has: (id) => onCanvas.has(id),
      revision: () => 0,
      async place(items, options) {
        if (options?.isCurrent && !options.isCurrent()) return 'unavailable'
        for (const item of items) onCanvas.add(item.artifactId)
        return 'placed'
      },
      focus() {},
      async thumbnail(id) {
        return onCanvas.has(id) ? 'data:image/png;base64,AQID' : null
      },
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    useAgentStore.setState({
      messages: [
        {
          kind: 'tool',
          id: 'tool-1',
          turnId: 'turn-1',
          toolCallId: 'call-1',
          title: '一只橘猫坐在窗台上',
          status: 'succeeded',
          delivery: 'conflict',
          artifacts: [
            {
              artifactId: 'agent_image_1',
              media: 'image',
              taskId: 'task-1',
              outputIndex: 0,
              mime: 'image/png',
            },
          ],
        },
      ],
    })
    render()
    const place = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '放入画布',
    )!
    await act(async () => {
      place.click()
      await vi.waitFor(() => expect(onCanvas.has('agent_image_1')).toBe(true))
    })

    expect(host.querySelector('img')).not.toBeNull()
    expect(texts('button')).not.toContain('放入画布')
    expect(useAgentStore.getState().messages[0]).toMatchObject({
      status: 'succeeded',
      delivery: 'placed',
    })
  })

  it('澄清渲染成可点的单选，点一下把那一项发成下一条消息', () => {
    const send = vi.fn(async () => {})
    useAgentStore.setState({
      send,
      messages: [
        {
          kind: 'clarification',
          id: 'clarify-1',
          turnId: 'turn-1',
          question: '要哪种风格？',
          options: ['写实照片', '扁平插画'],
        },
      ],
    })
    render()

    expect(host.textContent).toContain('要哪种风格？')
    const option = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '扁平插画',
    )!
    act(() => option.click())

    expect(send).toHaveBeenCalledWith('扁平插画')
  })

  it('作过答的澄清只剩状态标签，选项不再可点', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'clarification',
          id: 'clarify-1',
          turnId: 'turn-1',
          question: '要哪种风格？',
          options: ['写实照片', '扁平插画'],
        },
        {
          kind: 'text',
          id: 'user-2',
          turnId: 'turn-1',
          role: 'user',
          text: '写实照片',
          streaming: false,
        },
      ],
    })
    render()

    expect(host.textContent).toContain('已回答')
    const option = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '扁平插画',
    ) as HTMLButtonElement
    expect(option.disabled).toBe(true)
  })

  it('每轮页脚写耗时与合计消耗，点开看明细', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '画',
          streaming: false,
        },
      ],
      turns: {
        'turn-1': {
          turnId: 'turn-1',
          durationMs: 70_000,
          stopReason: 'completed',
          cost: { chat: 42, image: 85, video: 0 },
        },
      },
    })
    render()

    expect(host.textContent).toContain('本轮耗时 1m 10s')
    const toggle = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('消耗'),
    )!
    expect(toggle.textContent).toBe('消耗 127')

    act(() => toggle.click())
    expect(host.textContent).toContain('对话 42 · 生图 85')
  })

  it('进行中的轮写预扣数', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '画',
          streaming: false,
        },
      ],
      turns: { 'turn-1': { turnId: 'turn-1', reservedCredits: 60 } },
      turn: 'running',
    })
    render()

    expect(host.textContent).toContain('预扣 60')
    expect(host.textContent).not.toContain('本轮耗时')
  })

  it('失败的轮写本轮免费', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '画',
          streaming: false,
        },
      ],
      turns: {
        'turn-1': {
          turnId: 'turn-1',
          durationMs: 12_000,
          stopReason: 'failed',
          cost: { chat: 0, image: 0, video: 0 },
        },
      },
    })
    render()

    expect(host.textContent).toContain('本轮免费，未扣积分')
  })

  it('面板底部写本次会话的合计消耗', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '画',
          streaming: false,
        },
        {
          kind: 'text',
          id: 'user-2',
          turnId: 'turn-2',
          role: 'user',
          text: '再画',
          streaming: false,
        },
      ],
      turns: {
        'turn-1': {
          turnId: 'turn-1',
          durationMs: 1_000,
          stopReason: 'completed',
          cost: { chat: 42, image: 85, video: 0 },
        },
        'turn-2': {
          turnId: 'turn-2',
          durationMs: 1_000,
          stopReason: 'completed',
          cost: { chat: 60, image: 0, video: 125 },
        },
      },
    })
    render()

    expect(host.textContent).toContain('本次会话')
    expect(host.textContent).toContain('312')
  })

  it('计费关着的部署里页脚只剩耗时，会话合计不出现', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '画',
          streaming: false,
        },
      ],
      turns: { 'turn-1': { turnId: 'turn-1', durationMs: 12_000, stopReason: 'completed' } },
    })
    render()

    expect(host.textContent).toContain('本轮耗时 12s')
    expect(host.textContent).not.toContain('消耗')
    expect(host.textContent).not.toContain('本次会话')
  })

  it('能力关闭时什么都不渲染', async () => {
    await enableAgent(false)
    render()

    expect(host.innerHTML).toBe('')
  })
})
