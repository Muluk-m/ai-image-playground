// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import type { AgentMode, AgentTurnReference } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const skills = vi.hoisted(() => ({
  image: [] as { name: string; description: string }[],
  video: [{ name: 'storyboard-short', description: '何时用：一句话要一条多镜短片。' }],
}))

vi.mock('../../../../features/agent/lib/agentClient', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../../features/agent/lib/agentClient',
  )
  return { ...actual, fetchAgentSkills: async (mode: 'image' | 'video') => skills[mode] }
})

import AgentComposer from '../../../../features/agent/components/AgentComposer'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import { useAgentStore } from '../../../../features/agent/store'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { useLibraryStore } from '../../../../features/library/store'
import { chooseOption, stubPointerApis, triggerText } from '../../../helpers/radix'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc
let send: ReturnType<
  typeof vi.fn<
    (text: string, references: readonly AgentTurnReference[] | undefined, mode?: AgentMode) => void
  >
>

function render(): void {
  act(() => {
    root.render(<AgentComposer doc={doc} />)
  })
}

function editor(): HTMLElement {
  return host.querySelector<HTMLElement>('[contenteditable]')!
}

function type(text: string): void {
  const el = editor()
  el.appendChild(document.createTextNode(text))
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(label: string): void {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 技能候选是异步拉回来的，让那次 fetch 落地。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  stubPointerApis()
  const session = agentDraft(null)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  session.update(EMPTY_DRAFT)
  session.setSubmitting(false)
  doc = new CanvasDoc()
  send = vi.fn()
  useAgentStore.setState({
    turn: 'idle',
    conversationId: null,
    send: async (text, references, accepted, mode) => {
      send(text, references, mode)
      accepted?.()
    },
  })
  useLibraryStore.setState({ assets: [], loadAssets: async () => {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
})

describe('创作类型切换', () => {
  it('默认是图片，起轮就按图片发', async () => {
    render()
    await settle()
    expect(triggerText('创作类型')).toBe('图片')

    type('画一只猫')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('画一只猫', [], 'image')
  })

  it('切到视频之后这一轮按视频发，且发完不弹回图片', async () => {
    render()
    await settle()
    chooseOption('创作类型', '视频')
    await settle()

    type('做个开箱片')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('做个开箱片', [], 'video')
    expect(triggerText('创作类型')).toBe('视频')
  })
})

describe('`/` 技能候选', () => {
  it('视频轮打 `/` 弹出这个 mode 的技能，选中后补成命令', async () => {
    render()
    await settle()
    chooseOption('创作类型', '视频')
    await settle()

    type('/story')
    const option = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((one) =>
      one.textContent?.includes('storyboard-short'),
    )
    expect(option).toBeDefined()
    act(() => {
      option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(agentDraft(null).getSnapshot().draft.prompt).toBe('/storyboard-short ')
  })

  it('图片轮没有技能时不弹任何候选', async () => {
    render()
    await settle()
    type('/story')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
  })
})
