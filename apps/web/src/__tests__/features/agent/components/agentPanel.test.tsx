// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { type AgentCanvasSink, setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import {
  panelStateFromHistory,
  reduceAgentPanelEvent,
} from '../../../../features/agent/lib/panelMessages'
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
  'generation:video': false,
  'quota:daily': false,
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
    queue: [],
    turn: 'idle',
    reconnecting: false,
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
  it('发送中的引用显示本条消息的缩略图，确认起轮后不丢失或串成下一轮的图', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ skills: [] })),
    )
    const pending = {
      kind: 'text' as const,
      id: 'pending-1',
      turnId: 'pending-1',
      role: 'user' as const,
      text: '[image 2]这个换一身衣服，再参考[image 1]，不识别[image 3]',
      references: [
        { imageId: 'one', dataUrl: CANVAS_THUMBNAIL },
        { imageId: 'two', dataUrl: SERVER_IMAGE },
      ],
      streaming: false,
      pending: true as const,
    }
    useAgentStore.setState({ messages: [pending] })
    render()
    await settle()
    const log = host.querySelector('[aria-label="对话记录"]')!
    expect([...log.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      SERVER_IMAGE,
      CANVAS_THUMBNAIL,
    ])
    expect(log.textContent).toContain('这个换一身衣服，再参考')
    expect(log.textContent).not.toContain('[image 1]')
    expect(log.textContent).not.toContain('[image 2]')
    expect(log.textContent).toContain('[image 3]')
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    act(() => log.querySelector<HTMLButtonElement>('img')!.closest('button')!.click())
    expect(document.querySelector('[data-lightbox-root] img')?.getAttribute('src')).toBe(
      SERVER_IMAGE,
    )
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(document.querySelector('[data-lightbox-root]')).toBeNull()
    act(() => {
      agentDraft(null).update({
        prompt: '',
        references: [{ id: 'next', dataUrl: 'data:image/png;base64,TkVYVA==' }],
      })
      useAgentStore.setState(
        reduceAgentPanelEvent(
          { messages: [pending], turns: {} },
          { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' },
          { turnId: 'turn-1', pendingUserText: pending.text },
        ),
      )
    })
    expect([...log.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      SERVER_IMAGE,
      CANVAS_THUMBNAIL,
    ])
  })

  it('选区带进来的参考图正文里没有 [image N]，气泡外照样回显，换成服务端 id 后还在', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ skills: [] })),
    )
    const pending = {
      kind: 'text' as const,
      id: 'pending-2',
      turnId: 'pending-2',
      role: 'user' as const,
      text: '把它改成夜景',
      references: [{ imageId: 'selected', dataUrl: CANVAS_THUMBNAIL }],
      streaming: false,
      pending: true as const,
    }
    useAgentStore.setState({ messages: [pending] })
    render()
    await settle()
    const log = host.querySelector('[aria-label="对话记录"]')!
    expect([...log.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      CANVAS_THUMBNAIL,
    ])
    expect(log.textContent).toContain('把它改成夜景')
    act(() =>
      useAgentStore.setState(
        reduceAgentPanelEvent(
          { messages: [pending], turns: {} },
          { type: 'turnStart', turnId: 'turn-2', userMessageId: 'user-2' },
          { turnId: 'turn-2', pendingUserText: pending.text },
        ),
      ),
    )
    expect([...log.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual([
      CANVAS_THUMBNAIL,
    ])
  })

  it('历史引用按消息快照显示缩略图，点击才加载原图并随消息卸载释放预览', async () => {
    const revoke = vi.fn()
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(blob: Blob) {
          return blob.type === 'image/png' ? 'blob:archived-original' : 'blob:archived-reference'
        }
        static revokeObjectURL = revoke
      },
    )
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/messages/history-user/references/0?variant=original'))
        return new Response('original pixels', { headers: { 'content-type': 'image/png' } })
      if (String(input).endsWith('/messages/history-user/references/0'))
        return new Response('archived pixels', { headers: { 'content-type': 'image/webp' } })
      return Response.json({ skills: [] })
    })
    vi.stubGlobal('fetch', fetcher)
    useAgentStore.setState({
      conversationId: 'history-conversation',
      ...panelStateFromHistory({
        turns: [],
        messages: [
          {
            id: 'history-user',
            turnId: 'history-turn',
            role: 'user',
            createdAt: 1,
            content: [
              {
                type: 'text',
                text: '[image 1]换一身衣服',
                references: [
                  { imageId: 'old-image', image: { object: 'archived/input', mime: 'image/png' } },
                ],
              },
            ],
          },
        ],
      }),
    })
    render()
    await settle()
    const log = host.querySelector('[aria-label="对话记录"]')!
    expect(log.querySelector('img')?.getAttribute('src')).toBe('blob:archived-reference')
    expect(log.textContent).toBe('换一身衣服')
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('variant=original'))).toBe(
      false,
    )
    act(() => log.querySelector<HTMLImageElement>('img')!.closest('button')!.click())
    await settle()
    expect(document.querySelector('[data-lightbox-root] img')?.getAttribute('src')).toBe(
      'blob:archived-original',
    )
    act(() => useAgentStore.setState({ messages: [] }))
    expect(revoke).toHaveBeenCalledWith('blob:archived-reference')
    expect(document.querySelector('[data-lightbox-root]')).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:archived-original')
  })

  it('历史消息中的已知行首技能显示标题，普通斜杠文字保持原样', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          skills: [
            {
              name: 'character-sheet',
              title: '角色设定',
              icon: 'person-standing',
              summary: '',
              description: '',
            },
          ],
        }),
      ),
    )
    useAgentStore.setState({
      messages: ['/character-sheet 一只小猪', '解释 /character-sheet', '/unknown 一只小猪'].map(
        (text, index) => ({
          kind: 'text',
          id: `user-${index}`,
          turnId: `turn-${index}`,
          role: 'user',
          text,
          streaming: false,
        }),
      ),
    })
    render()
    await settle()
    const log = host.querySelector('[aria-label="对话记录"]')!
    expect(log.textContent).toContain('角色设定 一只小猪')
    expect(log.textContent).toContain('解释 /character-sheet')
    expect(log.textContent).toContain('/unknown 一只小猪')
    expect(log.querySelectorAll('[data-skill-name]')).toHaveLength(1)
  })

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

  it('没读到的那次不显示成读到了', () => {
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
            // 起跑那一刻还不知道读不读得到，标题照常是「读取技能：…」。
            title: '读取技能：nope',
            status: 'succeeded',
            skill: { label: 'nope', found: false },
          },
        ],
      }),
    )
    expect(host.querySelector('[data-tool="loadSkill"]')?.textContent).toBe('没找到技能：nope')
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

  it('离开底部时来了新内容出「有新消息」，点一下回到最新并恢复跟随', () => {
    render()
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { value: 200 },
    })
    const reply = (text: string) =>
      act(() =>
        useAgentStore.setState({
          messages: [
            { kind: 'text', id: 'reply', turnId: 't', role: 'assistant', text, streaming: true },
          ],
        }),
      )
    const jump = () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent === '有新消息')

    expect(jump()).toBeUndefined()
    log.scrollTop = 100
    act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })))
    // 只是往上翻、还没有新内容，不打扰。
    expect(jump()).toBeUndefined()
    reply('新回复')
    expect(log.scrollTop).toBe(100)
    expect(jump()).toBeDefined()

    Object.defineProperty(log, 'scrollHeight', { value: 1200 })
    act(() => jump()!.click())
    expect(log.scrollTop).toBe(1200)
    expect(jump()).toBeUndefined()

    // 回到最新后继续跟随流式输出。
    Object.defineProperty(log, 'scrollHeight', { value: 1400 })
    reply('新回复继续')
    expect(log.scrollTop).toBe(1400)
    expect(jump()).toBeUndefined()
  })

  it('自己滚回底部时「有新消息」随之消失', () => {
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
          { kind: 'text', id: 'r', turnId: 't', role: 'assistant', text: '新', streaming: true },
        ],
      }),
    )
    expect(texts('button')).toContain('有新消息')
    log.scrollTop = 800
    act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(texts('button')).not.toContain('有新消息')
  })

  it('离开底部时只改旧卡片的交付状态或收尾一轮，不出「有新消息」', () => {
    const reply = {
      kind: 'text' as const,
      id: 'reply',
      turnId: 'turn-1',
      role: 'assistant' as const,
      text: '画好了',
      streaming: true,
    }
    // 卡片不带产物：这个用例只看数组换引用，不去取缩略图。
    const card = (delivery: AgentDeliveryStatus) => ({ ...toolMessage(delivery), artifacts: [] })
    useAgentStore.setState({ messages: [card('pending'), reply], turns: {} })
    render()
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { value: 200 },
    })
    log.scrollTop = 100
    act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })))

    // 画布接住了旧卡片的产物：数组换了引用，但末尾没有长出新内容。
    act(() => useAgentStore.setState({ messages: [card('placed'), reply] }))
    expect(texts('button')).not.toContain('有新消息')
    // 一轮收尾只是把流式标记摘掉。
    act(() =>
      useAgentStore.setState({ messages: [card('placed'), { ...reply, streaming: false }] }),
    )
    expect(texts('button')).not.toContain('有新消息')
    expect(log.scrollTop).toBe(100)
  })

  it('离开底部时自己发出消息，直接回到最新并继续跟随回复', () => {
    const reply = {
      kind: 'text' as const,
      id: 'reply',
      turnId: 'turn-1',
      role: 'assistant' as const,
      text: '上一轮',
      streaming: false,
    }
    useAgentStore.setState({ messages: [reply], turns: {} })
    render()
    const log = host.querySelector<HTMLElement>('[aria-label="对话记录"]')!
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { value: 200 },
    })
    log.scrollTop = 100
    act(() => log.dispatchEvent(new Event('scroll', { bubbles: true })))

    const mine = {
      kind: 'text' as const,
      id: 'mine',
      turnId: 'turn-2',
      role: 'user' as const,
      text: '再来一张',
      streaming: false,
      pending: true as const,
    }
    Object.defineProperty(log, 'scrollHeight', { value: 1200 })
    act(() => useAgentStore.setState({ messages: [reply, mine] }))
    expect(log.scrollTop).toBe(1200)
    expect(texts('button')).not.toContain('有新消息')

    Object.defineProperty(log, 'scrollHeight', { value: 1400 })
    act(() =>
      useAgentStore.setState({
        messages: [
          reply,
          mine,
          { ...reply, id: 'reply-2', turnId: 'turn-2', text: '好的', streaming: true },
        ],
      }),
    )
    expect(log.scrollTop).toBe(1400)
    expect(texts('button')).not.toContain('有新消息')
  })

  it('回复带复制按钮，复制的是原文并提示已复制；流式中不出', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const raw = '可以整理。\n\n- **横向一排**：5 个并列'
    useAgentStore.setState({
      messages: [
        { kind: 'text', id: 'a-1', turnId: 't-1', role: 'assistant', text: raw, streaming: false },
        {
          kind: 'text',
          id: 'a-2',
          turnId: 't-2',
          role: 'assistant',
          text: '还在说',
          streaming: true,
        },
      ],
      turns: {},
    })
    render()

    const copies = host.querySelectorAll<HTMLButtonElement>('button[aria-label="复制回复"]')
    expect(copies).toHaveLength(1)
    await act(async () => {
      copies[0].click()
    })
    expect(writeText).toHaveBeenCalledWith(raw)
    expect(copies[0].getAttribute('aria-label')).toBe('已复制')
    expect(copies[0].textContent).toContain('已复制')
    Reflect.deleteProperty(navigator, 'clipboard')
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

  function answeredClarification(answer: string) {
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
          turnId: 'turn-2',
          role: 'user',
          text: answer,
          streaming: false,
        },
      ],
    })
  }

  it('作过答的澄清折叠成「已选」，原问题与选项收起来', () => {
    answeredClarification('写实照片')
    render()

    expect(host.textContent).toContain('已选：写实照片')
    expect(host.textContent).not.toContain('要哪种风格？')
    expect(texts('button')).not.toContain('扁平插画')
    expect(texts('button')).not.toContain('其他…')
  })

  it('自己写的回答也折叠成「已选」', () => {
    answeredClarification('水墨国风')
    render()

    expect(host.textContent).toContain('已选：水墨国风')
  })

  it('展开作过答的澄清能看回原问题与选项，但选项不再可点', () => {
    answeredClarification('写实照片')
    render()

    const toggle = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('已选：写实照片'),
    ) as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    act(() => toggle.click())

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('要哪种风格？')
    const option = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '扁平插画',
    ) as HTMLButtonElement
    expect(option.disabled).toBe(true)
    expect(texts('button')).not.toContain('其他…')
  })

  it('被后一张澄清顶掉、却没有回答可折叠的澄清，仍标「已回答」并锁住选项', () => {
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
          kind: 'clarification',
          id: 'clarify-2',
          turnId: 'turn-1',
          question: '要什么比例？',
          options: ['方形', '竖版'],
        },
      ],
    })
    render()

    expect(host.textContent).toContain('要哪种风格？')
    expect(host.textContent).toContain('已回答')
    const option = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '扁平插画',
    ) as HTMLButtonElement
    expect(option.disabled).toBe(true)
    const next = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '竖版',
    ) as HTMLButtonElement
    expect(next.disabled).toBe(false)
  })

  it('断线续播时顶部出一条细提示，接上后消失', () => {
    useAgentStore.setState({ turn: 'running', reconnecting: true })
    render()

    expect(host.querySelector('[role="status"]')?.textContent).toBe('连接中断，正在重新连接…')

    act(() => useAgentStore.setState({ reconnecting: false }))

    expect(host.textContent).not.toContain('正在重新连接')
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

  it('重试记录夹在一轮中间时，页脚仍只跟在这一轮最后一条后面', () => {
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
          kind: 'tool',
          id: 'retry-1',
          turnId: 'retry-turn',
          toolCallId: 'retry-call',
          title: '一只橘猫',
          status: 'submitted',
          retryOf: { messageId: 'tool-0', toolCallId: 'call-0' },
        },
        {
          kind: 'text',
          id: 'reply-1',
          turnId: 'turn-1',
          role: 'assistant',
          text: '好的',
          streaming: false,
        },
      ],
      turns: {
        'turn-1': { turnId: 'turn-1', durationMs: 12_000, stopReason: 'completed' },
      },
    })
    render()

    expect(host.textContent?.match(/本轮耗时 12s/g)).toHaveLength(1)
    expect(host.textContent?.indexOf('本轮耗时')).toBeGreaterThan(host.textContent!.indexOf('好的'))
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

  it('被服务重启打断、已自动续上的轮标明已中断，不报失败', () => {
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
          error: 'agent_turn_interrupted',
          cost: { chat: 0, image: 0, video: 0 },
        },
      },
    })
    render()

    expect(host.textContent).toContain('已中断，已自动续上')
    expect(host.textContent).not.toContain('本轮失败')
  })

  it('停止的轮留下说了一半的回复，页脚标明已停止而不是失败', () => {
    useAgentStore.setState({
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '画一只猫',
          streaming: false,
        },
        {
          kind: 'text',
          id: 'assistant-1',
          turnId: 'turn-1',
          role: 'assistant',
          text: '好的，我先',
          streaming: false,
        },
      ],
      turns: { 'turn-1': { turnId: 'turn-1', durationMs: 3_000, stopReason: 'aborted' } },
    })
    render()

    expect(host.textContent).toContain('好的，我先')
    expect(host.textContent).toContain('已停止')
    expect(host.textContent).not.toContain('本轮失败')
  })

  it('项目标题保持单行，消耗只出现在每轮页脚', () => {
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

    expect(host.querySelector('.studio-agent-project')?.textContent).not.toContain('已用')
    expect(host.textContent).not.toContain('312')
    expect(host.textContent).toContain('127')
    expect(host.textContent).toContain('185')
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

  describe('排队列表', () => {
    const queued = (id: string, text: string, referenceCount = 0) => ({
      id,
      clientMessageId: `client-${id}`,
      text,
      referenceCount,
      createdAt: 1,
    })

    it('没有排队消息时不占位置', () => {
      render()
      expect(host.querySelector('section[aria-label^="排队中"]')).toBeNull()
    })

    it('在输入框上方按顺序列出排队消息，忙时发送按钮写着加入排队', () => {
      useAgentStore.setState({
        conversationId: 'conversation-1',
        turn: 'running',
        activeTurn: { turnId: 'turn-1' },
        queue: [queued('queue-1', '再加一只狗', 2), queued('queue-2', '换成蓝色背景')],
      })
      render()

      const list = host.querySelector('section[aria-label="排队中 2 条"]')!
      expect(list).not.toBeNull()
      expect(texts('section[aria-label="排队中 2 条"] li')).toEqual([
        '再加一只狗2 张图',
        '换成蓝色背景',
      ])
      // 列表在输入框之前：读的顺序就是处理的顺序，也就在输入框正上方。
      const composer = host.querySelector('.studio-agent-composer')!
      expect(list.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(host.querySelector('button[aria-label="加入排队"]')).not.toBeNull()
    })

    it('轮到时没能开轮的那一条写明原因，按钮是移除', () => {
      useAgentStore.setState({
        conversationId: 'conversation-1',
        queue: [
          { ...queued('queue-1', '再加一只狗'), failure: 'insufficient_credits' as const },
          queued('queue-2', '换成蓝色背景'),
        ],
      })
      render()

      expect(texts('section[aria-label^="排队中"] li')).toEqual([
        '再加一只狗余额不足，未处理',
        '换成蓝色背景',
      ])
      // 还等着处理的只有一条。
      expect(host.textContent).toContain('排队中 1 条')
      expect(
        host.querySelector('button[aria-label="移除这条没能处理的消息：再加一只狗"]'),
      ).not.toBeNull()
      expect(
        host.querySelector('button[aria-label="撤回这条排队消息：换成蓝色背景"]'),
      ).not.toBeNull()
    })

    it('点撤回向服务端撤回那一条，成功后从列表拿掉', async () => {
      const requests: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (init?.method === 'POST' && url.includes('/withdraw')) {
            requests.push(url)
            return Response.json({ result: 'cancelled' })
          }
          return Response.json({ skills: [] })
        }),
      )
      useAgentStore.setState({
        conversationId: 'conversation-1',
        turn: 'running',
        activeTurn: { turnId: 'turn-1' },
        queue: [queued('queue-1', '再加一只狗'), queued('queue-2', '换成蓝色背景')],
      })
      render()

      const withdraw = host.querySelector<HTMLButtonElement>(
        'button[aria-label="撤回这条排队消息：换成蓝色背景"]',
      )!
      await act(async () => {
        withdraw.click()
      })
      await settle()

      expect(requests).toEqual([
        'http://bff.test/api/agent/conversations/conversation-1/queue/queue-2/withdraw',
      ])
      expect(texts('section[aria-label^="排队中"] li')).toEqual(['再加一只狗'])
    })

    it('智能体忙时每条排队消息可以现在插话，点了就插进正在跑的那一轮', async () => {
      const requests: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (init?.method === 'POST' && url.endsWith('/interject')) {
            requests.push(url)
            return Response.json({ result: 'interjected', turnId: 'turn-1' })
          }
          return Response.json({ skills: [] })
        }),
      )
      useAgentStore.setState({
        conversationId: 'conversation-1',
        turn: 'running',
        activeTurn: { turnId: 'turn-1' },
        queue: [
          queued('queue-1', '再加一只狗'),
          { ...queued('queue-2', '换成蓝色背景'), failure: 'insufficient_credits' as const },
        ],
      })
      render()

      // 没能开轮的那一条不再排着，也就没有插话可言。
      expect(host.querySelector('button[aria-label="现在插话：换成蓝色背景"]')).toBeNull()
      const interject = host.querySelector<HTMLButtonElement>(
        'button[aria-label="现在插话：再加一只狗"]',
      )!
      await act(async () => {
        interject.click()
      })
      await settle()

      expect(requests).toEqual([
        'http://bff.test/api/agent/conversations/conversation-1/queue/queue-1/interject',
      ])
      expect(texts('section[aria-label^="排队中"] li')).toEqual(['换成蓝色背景余额不足，未处理'])
    })

    it('智能体空闲时没有现在插话', () => {
      useAgentStore.setState({
        conversationId: 'conversation-1',
        queue: [queued('queue-1', '再加一只狗')],
      })
      render()

      expect(host.querySelector('button[aria-label^="现在插话"]')).toBeNull()
    })
  })
})
