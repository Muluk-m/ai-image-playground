// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { type AgentCanvasSink, setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import { useAgentStore } from '../../../../features/agent/store'
import type { AgentDeliveryStatus, AgentToolMessage } from '../../../../features/agent/types'
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

/** 画布渲出来的缩略图；服务端回退取回来的是 SERVER_IMAGE。 */
const CANVAS_THUMBNAIL = 'data:image/png;base64,Q0FOVkFT'
const SERVER_IMAGE = 'data:image/png;base64,AQID'

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
    // 面板只把 editor 转交给创作记录页签；这些用例不点创作记录，给个空壳就够。
    const editor = { scrollToElements: () => {} } as unknown as CanvasEditor
    root.render(<AgentPanel doc={new CanvasDoc()} editor={editor} />)
  })
}

function texts(selector: string): string[] {
  return [...host.querySelectorAll(selector)].map((node) => node.textContent ?? '')
}

/** 缩略图是异步取回来的：等它取完，act 退出时这一批更新才刷进 DOM。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function toolMessage(
  delivery: AgentDeliveryStatus,
  artifactId = 'agent_image_1',
): AgentToolMessage {
  return {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    title: '一只橘猫坐在窗台上',
    status: 'succeeded',
    delivery,
    artifacts: [
      { artifactId, media: 'image', taskId: 'task-1', outputIndex: 0, mime: 'image/png' },
    ],
  }
}

beforeEach(async () => {
  const session = agentDraft(null)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  session.update(EMPTY_DRAFT)
  session.setSubmitting(false)
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
    historyLoading: false,
    historyFailed: false,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

/** 这几个用例只看结果卡与手动放入，占位那三个方法给个不动画布的空实现。 */
function stubCanvasSink(
  partial: Pick<AgentCanvasSink, 'has' | 'place' | 'focus' | 'thumbnail'>,
): void {
  setAgentCanvasSink({
    async reserve() {
      return []
    },
    discard() {},
    markFailed() {},
    ...partial,
  })
}

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setAgentCanvasSink(null)
  vi.unstubAllGlobals()
})

describe('AgentPanel', () => {
  it('读取技能只出一行脚注，不出结果卡', () => {
    render()
    act(() =>
      useAgentStore.setState({
        messages: [
          {
            kind: 'tool',
            id: 'tool-skill',
            turnId: 'turn-1',
            toolCallId: 'call-skill',
            toolName: 'loadSkill',
            title: '读取技能：storyboard-short',
            status: 'succeeded',
          },
          {
            kind: 'tool',
            id: 'tool-image',
            turnId: 'turn-1',
            toolCallId: 'call-image',
            toolName: 'generateImage',
            title: '一只橘猫',
            status: 'running',
          },
        ],
      }),
    )
    const line = host.querySelector<HTMLElement>('[data-tool="loadSkill"]')
    expect(line?.textContent).toBe('读取技能：storyboard-short')
    // 结果卡有边框底座，技能那一行没有；这里数的就是「出了几张卡」。
    expect(host.querySelectorAll('.rounded-xl.border')).toHaveLength(1)
  })

  it('上翻阅读历史时保留位置，回到底部后继续跟随流式回复', () => {
    render()
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { value: 200 },
    })
    log.scrollTop = 100
    act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })))
    act(() =>
      useAgentStore.setState({
        messages: [
          {
            kind: 'text',
            id: 'reply',
            turnId: 't',
            role: 'assistant',
            text: '新回复',
            streaming: true,
          },
        ],
      }),
    )
    expect(log.scrollTop).toBe(100)
    log.scrollTop = 800
    act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })))
    Object.defineProperty(log, 'scrollHeight', { value: 1200 })
    act(() =>
      useAgentStore.setState({
        messages: [
          {
            kind: 'text',
            id: 'reply',
            turnId: 't',
            role: 'assistant',
            text: '新回复继续',
            streaming: true,
          },
        ],
      }),
    )
    expect(log.scrollTop).toBe(1200)
  })

  it('渲染对话与创作记录两个页签', () => {
    render()

    expect(texts('button')).toContain('对话')
    expect(texts('button')).toContain('创作记录')
  })

  it('切到创作记录页签显示画布对象', () => {
    render()
    const layers = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '创作记录',
    )!
    act(() => layers.click())

    expect(host.textContent).toContain('还没有创作记录')
    expect(host.querySelector('textarea')).toBeNull()
  })

  it('收起后只留一个重新打开的入口', () => {
    render()
    const collapse = host.querySelector('button[aria-label="收起面板"]') as HTMLButtonElement
    act(() => collapse.click())

    expect(host.querySelector('textarea')).toBeNull()
    expect(texts('button')).toEqual(['展开对话'])
  })

  it('对话记录里的文字可以选中复制', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '修改这个扶手部分',
          streaming: false,
        },
      ],
    })
    render()

    const bubble = [...host.querySelectorAll('p')].find(
      (one) => one.textContent === '修改这个扶手部分',
    )!
    expect(bubble.closest('[data-selectable-text]')).not.toBeNull()
  })

  it('文件拖到对话记录上也进输入框的引用区', async () => {
    render()
    const log = host.querySelector('[data-image-dropzone]')!
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'ref.png', { type: 'image/png' })
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file], types: ['Files'] } })
    act(() => {
      log.dispatchEvent(event)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(host.textContent).toContain('ref')
  })

  it('产物真正落画布后才显示可定位缩略图，不必重新挂载面板', async () => {
    const focused: string[] = []
    stubCanvasSink({
      has: () => true,
      async place() {
        return 'placed'
      },
      focus: (objectIds) => focused.push(...objectIds),
      async thumbnail() {
        return CANVAS_THUMBNAIL
      },
    })
    useAgentStore.setState({ messages: [toolMessage('pending')] })
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

    // 点标题把这一次的产物全部定位、选中。
    focused.length = 0
    const title = host.querySelector('button[title="在画布上定位这些产物"]') as HTMLButtonElement
    act(() => title.click())
    expect(focused).toEqual(['agent_image_1'])
  })

  it('不在画布上的产物可以再放入，放入后换成可定位的缩略图', async () => {
    const onCanvas = new Set<string>()
    stubCanvasSink({
      has: (id) => onCanvas.has(id),
      async place(items, options) {
        if (options?.isCurrent && !options.isCurrent()) return 'unavailable'
        for (const item of items) onCanvas.add(item.artifactId)
        return 'placed'
      },
      focus() {},
      // 与服务端回退取回来的那份区分开，好看出缩略图究竟来自哪一边。
      async thumbnail(id) {
        return onCanvas.has(id) ? CANVAS_THUMBNAIL : null
      },
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    useAgentStore.setState({ messages: [toolMessage('unavailable')] })
    render()
    // 入口从画布反查，反查是异步的。
    await settle()
    const place = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '放入画布',
    )!
    await act(async () => {
      place.click()
      await vi.waitFor(() => expect(onCanvas.has('agent_image_1')).toBe(true))
    })
    await settle()

    expect(host.querySelector('img')?.getAttribute('src')).toBe(CANVAS_THUMBNAIL)
    expect(texts('button')).not.toContain('放入画布')
    expect(useAgentStore.getState().messages[0]).toMatchObject({
      status: 'succeeded',
      delivery: 'placed',
    })
  })

  it('刷新后没落画布的产出仍看得见，并留着放入画布的入口', async () => {
    const onCanvas = new Set<string>()
    stubCanvasSink({
      has: (id) => onCanvas.has(id),
      async place(items) {
        for (const item of items) onCanvas.add(item.artifactId)
        return 'placed'
      },
      focus() {},
      // 画布上没有这个对象，画布给不出缩略图。
      async thumbnail(id) {
        return onCanvas.has(id) ? CANVAS_THUMBNAIL : null
      },
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    // 刷新后交付状态是从画布反查出来的：这张图不在画布上。
    useAgentStore.setState({ messages: [toolMessage('unavailable', 'agent_image_refresh')] })
    render()
    await settle()

    expect(host.querySelector('img')?.getAttribute('src')).toBe(SERVER_IMAGE)
    expect(host.textContent).toContain('产物不在当前画布上，可以再放入。')
    expect(texts('button')).toContain('放入画布')
  })

  it('入口从画布反查：在画布上就不给，被删掉后重新给', async () => {
    const onCanvas = new Set(['agent_image_1'])
    stubCanvasSink({
      has: (id) => onCanvas.has(id),
      async place() {
        return 'placed'
      },
      focus() {},
      async thumbnail(id) {
        return onCanvas.has(id) ? CANVAS_THUMBNAIL : null
      },
    })
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    useAgentStore.setState({ messages: [toolMessage('placed')] })
    render()
    await settle()

    expect(host.querySelector('img')?.getAttribute('src')).toBe(CANVAS_THUMBNAIL)
    expect(texts('button')).not.toContain('放入画布')

    // 用户把这张图从画布上删了，再折叠展开一次面板。
    onCanvas.delete('agent_image_1')
    act(() => (host.querySelector('button[aria-label="收起面板"]') as HTMLButtonElement).click())
    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    await settle()

    expect(host.querySelector('img')?.getAttribute('src')).toBe(SERVER_IMAGE)
    expect(texts('button')).toContain('放入画布')
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

  it('方案都不对时点「其他」，在卡片里写一句就是下一条消息', () => {
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

    const other = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '其他…',
    )!
    act(() => other.click())
    const field = host.querySelector('input[aria-label="其他回答"]') as HTMLInputElement
    const submit = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '发送' && button.getAttribute('type') === 'submit',
    ) as HTMLButtonElement
    // 空着不能发：一条空回答只会让助手再问一遍。
    expect(submit.disabled).toBe(true)

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(field, '  水墨国风  ')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(send).toHaveBeenCalledWith('水墨国风')
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
    const other = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '其他…',
    ) as HTMLButtonElement
    expect(other.disabled).toBe(true)
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

  it('进行中的轮不写预扣，末尾亮状态行', () => {
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
      activeTurn: { turnId: 'turn-1' },
    })
    render()

    expect(host.textContent).not.toContain('预扣')
    expect(host.textContent).not.toContain('本轮耗时')
    expect(host.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('thinking')
    expect(host.textContent).toContain('思考中')
  })

  it('助手回复按 Markdown 渲染，不折叠', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'assistant-1',
          turnId: 'turn-1',
          role: 'assistant',
          text:
            '可以整理。\n\n- **横向一排**：5 个并列\n- **两行网格**：上 3 下 2\n\n' +
            '很长的一段。'.repeat(40),
          streaming: false,
        },
      ],
      turns: {},
    })
    render()

    expect(host.querySelectorAll('li')).toHaveLength(2)
    expect(host.querySelector('strong')?.textContent).toBe('横向一排')
    expect(host.textContent).not.toContain('**')
    expect(host.textContent).not.toContain('展开')
  })

  it('面板宽度跟着 store，右缘有拖宽手柄', () => {
    useAgentStore.setState({ panelWidth: 420 })
    render()

    const panel = host.querySelector('[role="separator"]')?.parentElement as HTMLElement
    expect(panel.style.width).toBe('420px')
    expect(host.querySelector('[aria-label="拖动调整面板宽度"]')).not.toBeNull()
  })

  it('失败的轮明确标出失败和未扣积分，不显示为免费完成', () => {
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

    expect(host.textContent).toContain('本轮失败')
    expect(host.textContent).toContain('未扣积分')
    expect(host.textContent).not.toContain('本轮免费')
  })

  it('项目标题旁显示已用积分', () => {
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

    expect(host.textContent).toContain('已用')
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
    expect(host.textContent).not.toContain('已用')
  })

  it('能力关闭时什么都不渲染', async () => {
    await enableAgent(false)
    render()

    expect(host.innerHTML).toBe('')
  })
})
