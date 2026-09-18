// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPanel from '../../../../features/agent/components/AgentPanel'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import { useAgentStore } from '../../../../features/agent/store'
import ProjectWelcome from '../../../../features/canvas/components/ProjectWelcome'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../../../features/canvas/lib/editor'
import type { CanvasWorkspace } from '../../../../features/canvas/lib/workspaces'
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
  return [...(suggestionList()?.querySelectorAll('button') ?? [])]
}

function textbox(): HTMLElement {
  return host.querySelector<HTMLElement>('[role="textbox"]')!
}

beforeEach(async () => {
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
    const prompt = suggestion.dataset.prompt!
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

    expect(textbox().textContent).toBe(second!.dataset.prompt)
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

  it('项目欢迎页展示示例建议，点一下填进欢迎页的输入框', async () => {
    const workspace = { doc: new CanvasDoc(), editor: EDITOR } as unknown as CanvasWorkspace
    act(() => root.render(<ProjectWelcome workspace={workspace} />))
    await settle()

    const suggestion = suggestionButtons()[1]!
    act(() => suggestion.click())
    await settle()

    expect(textbox().textContent).toBe(suggestion.dataset.prompt)
    expect(document.activeElement).toBe(textbox())
    expect(send).not.toHaveBeenCalled()
  })
})
