// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { useInspirationStore } from '../../../../features/inspiration/store'
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

const EDITOR = { scrollToElements: () => {} } as unknown as CanvasEditor

let host: HTMLDivElement
let root: Root
let send: ReturnType<typeof vi.fn>

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function suggestionList(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[aria-label="示例提示词"]')
}

function suggestionButtons(): HTMLButtonElement[] {
  return [...(suggestionList()?.querySelectorAll<HTMLButtonElement>('article button') ?? [])]
}

function promptFor(button: HTMLButtonElement): string {
  const title = button.closest('article')!.querySelector('h4')!.textContent
  return useInspirationStore.getState().items.find((item) => item.title === title)!.prompt
}

function textbox(): HTMLElement {
  return host.querySelector<HTMLElement>('[role="textbox"]')!
}

beforeEach(async () => {
  useInspirationStore.setState({
    items: ['Product', 'Poster', 'Character'].map((title, index) => ({
      id: String(index),
      title,
      kind: 'showcase',
      category: 'Creative',
      prompt: `Create a detailed ${title} image`,
      thumbnailUrl: `/sample-${index}.png`,
      recommendedModel: 'gpt-image-2.5-flare',
      recommendedProvider: 'openai-compat',
      params: { size: 'auto' },
    })),
    loadRemote: async () => {},
  })
  const session = agentDraft(null)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  session.update(EMPTY_DRAFT)
  session.setSubmitting(false)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(MANIFEST)),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  vi.unstubAllGlobals()
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  useAgentStore.getState().startNewConversation()
  send = vi.fn(async () => 'accepted')
  useAgentStore.setState({
    send: send as never,
    load: async () => {},
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

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('示例建议', () => {
  it('空对话展示可点的示例建议，点一下填进输入框并聚焦，不发送', async () => {
    act(() => root.render(<AgentPanel doc={new CanvasDoc()} editor={EDITOR} />))
    await settle()

    const buttons = suggestionButtons()
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    const suggestion = buttons[0]!
    const prompt = promptFor(suggestion)
    expect(prompt.length).toBeGreaterThan(10)

    act(() => suggestion.click())
    await settle()

    expect(textbox().textContent).toBe(prompt)
    expect(document.activeElement).toBe(textbox())
    expect(agentDraft(null).getSnapshot().draft.prompt).toBe(prompt)
    expect(send).not.toHaveBeenCalled()
    expect(useAgentStore.getState().messages).toEqual([])
  })

  it('再点另一条建议换成那一条，不叠在后面', async () => {
    act(() => root.render(<AgentPanel doc={new CanvasDoc()} editor={EDITOR} />))
    await settle()

    const [first, second] = suggestionButtons()
    act(() => first!.click())
    await settle()
    act(() => second!.click())
    await settle()

    expect(textbox().textContent).toBe(promptFor(second!))
  })

  it('对话开始后建议不再显示', async () => {
    act(() => root.render(<AgentPanel doc={new CanvasDoc()} editor={EDITOR} />))
    await settle()
    expect(suggestionList()).not.toBeNull()

    act(() =>
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
        ],
      }),
    )

    expect(suggestionList()).toBeNull()
  })

  it('点击试一下会替换已有草稿并清空参考图', async () => {
    agentDraft(null).update({
      ...EMPTY_DRAFT,
      prompt: '我自己写了一半的话',
      references: [{ id: 'old', dataUrl: 'data:image/png;base64,old' }],
    })
    act(() => root.render(<AgentPanel doc={new CanvasDoc()} editor={EDITOR} />))
    await settle()

    const button = suggestionButtons()[0]!
    act(() => button.click())
    await settle()

    expect(agentDraft(null).getSnapshot().draft.prompt).toBe(promptFor(button))
    expect(textbox().textContent).toBe(promptFor(button))
    expect(agentDraft(null).getSnapshot().draft.references).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('修改建议后再次试一下仍完整替换', async () => {
    act(() => root.render(<AgentPanel doc={new CanvasDoc()} editor={EDITOR} />))
    await settle()

    const [first, second] = suggestionButtons()
    act(() => first!.click())
    await settle()
    const edited = `${promptFor(first!)}，再加一只猫`
    act(() => agentDraft(null).update((current) => ({ ...current, prompt: edited })))
    await settle()
    act(() => second!.click())
    await settle()

    expect(agentDraft(null).getSnapshot().draft.prompt).toBe(promptFor(second!))
  })
})
