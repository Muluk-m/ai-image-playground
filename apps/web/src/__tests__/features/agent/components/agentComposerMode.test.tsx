// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import type { AgentMode, AgentTurnReference } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const videoAvailable = vi.hoisted(() => ({ value: true }))

vi.mock('../../../../lib/channels/videoChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/channels/videoChannels')>()),
  isVideoModeAvailable: () => videoAvailable.value,
}))

type SkillFixture = {
  name: string
  title: string
  description: string
  icon: string
  summary: string
}

const skills = vi.hoisted(() => ({
  image: [] as SkillFixture[],
  video: [
    {
      name: 'storyboard-short',
      title: '分镜短片',
      description: '何时用：一句话要一条多镜短片。不处理：单张图。',
      icon: 'clapperboard',
      summary: '一句话生成多镜头短片，自动产出分镜脚本与成片',
    },
    // 没写 summary 的那条：次行要退回 description，并且不带「何时用：」这个给模型的路牌。
    {
      name: 'image-to-video',
      title: '让图动起来',
      description: '何时用：让一张已有的图动起来。不处理：多镜成片。',
      icon: 'image-play',
      summary: '',
    },
  ] as SkillFixture[],
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
import { useCanvasComposer } from '../../../../features/canvas/composerStore'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { useLibraryStore } from '../../../../features/library/store'
import { chooseOption, stubPointerApis } from '../../../helpers/radix'

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
  videoAvailable.value = true
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
  useCanvasComposer.setState({ agentVideoPending: false })
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

    type('画一只猫')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('画一只猫', [], 'image')
  })

  it('切到视频之后这一轮按视频发，且发完不弹回图片', async () => {
    render()
    await settle()
    chooseOption('创作类型：图片', '视频')
    await settle()

    type('做个开箱片')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('做个开箱片', [], 'video')
    type('再来一段')
    click('发送并创作')
    expect(send).toHaveBeenLastCalledWith('再来一段', [], 'video')
  })

  it('切换同时写进会话状态，代用户发一轮的入口据此跟上', async () => {
    render()
    await settle()
    expect(useAgentStore.getState().mode).toBe('image')

    chooseOption('创作类型：图片', '视频')
    await settle()

    expect(useAgentStore.getState().mode).toBe('video')
  })
})

describe('从视频入口或「生成视频」进来', () => {
  it('下一轮预置为视频，只接手一次，之后用户照常能切回图片', async () => {
    useCanvasComposer.setState({ agentVideoPending: true })
    render()
    await settle()

    expect(useAgentStore.getState().mode).toBe('video')
    expect(useCanvasComposer.getState().agentVideoPending).toBe(false)

    chooseOption('创作类型：视频', '图片')
    await settle()
    type('画一只猫')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('画一只猫', [], 'image')
  })

  it('输入框已经开着时也跟着切', async () => {
    render()
    await settle()
    expect(useAgentStore.getState().mode).toBe('image')

    act(() => useCanvasComposer.setState({ agentVideoPending: true }))
    await settle()

    type('做个开箱片')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('做个开箱片', [], 'video')
  })

  it('做不了视频的部署不接手，也不按视频发', async () => {
    videoAvailable.value = false
    useCanvasComposer.setState({ agentVideoPending: true })
    render()
    await settle()

    expect(useAgentStore.getState().mode).toBe('image')
  })
})

describe('部署做不了视频时', () => {
  it('不给「视频」这个选项', async () => {
    videoAvailable.value = false
    render()
    await settle()

    const trigger = document.querySelector<HTMLElement>('[aria-label^="创作类型"]')
    // 只有一个选项时开关本身也没有意义了。
    expect(trigger).toBeNull()
    expect(host.textContent).not.toContain('视频')
  })

  it('把上次存下来的视频草稿归一成图片，不按视频发出去', async () => {
    const session = agentDraft(null)
    session.update((draft) => ({ ...draft, mode: 'video' }))
    videoAvailable.value = false
    render()
    await settle()

    type('画一只猫')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith('画一只猫', [], 'image')
    expect(useAgentStore.getState().mode).toBe('image')
  })
})

describe('`/` 技能候选', () => {
  it('视频轮打 `/` 弹出图标、中文标题与用户向简介，选中后补成 `/name`', async () => {
    render()
    await settle()
    chooseOption('创作类型：图片', '视频')
    await settle()

    type('/story')
    const option = [...host.querySelectorAll<HTMLElement>('[role="option"]')][0]
    expect(option).toBeDefined()
    // 主行是人看的标题，次行是写给用户的那句话；kebab-case 的标识不该露在面上。
    expect(option!.textContent).toContain('分镜短片')
    expect(option!.textContent).toContain('一句话生成多镜头短片，自动产出分镜脚本与成片')
    expect(option!.textContent).not.toContain('storyboard-short')
    // 写给模型的「何时用 / 不处理」不该露给用户。
    expect(option!.textContent).not.toContain('何时用')
    expect(option!.textContent).not.toContain('不处理')
    // 每一行左侧都有图标，而且不同技能不是同一个。
    expect(option!.querySelector('[data-skill-icon="clapperboard"]')).not.toBeNull()

    act(() => {
      option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    // 插进去的仍是标识：服务端只认它。
    expect(agentDraft(null).getSnapshot().draft.prompt).toBe('/storyboard-short ')
  })

  it('技能标题与缩略图混排后仍按原命令和引用序号发送', async () => {
    render()
    await settle()
    chooseOption('创作类型：图片', '视频')
    await settle()
    type('/story')
    const option = host.querySelector<HTMLElement>('[role="option"]')!
    act(() => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    type('参考 @')
    const session = agentDraft(null)
    act(() => {
      session.update((draft) => ({
        ...draft,
        prompt: '/storyboard-short 参考 \u2063@图1\u2064',
        references: [{ id: 'ref', dataUrl: 'data:image/png;base64,aGk=' }],
      }))
    })
    type(' 做成短片')
    expect(editor().textContent).toContain('分镜短片')
    expect(editor().textContent).not.toContain('/storyboard-short')
    click('发送并创作')
    expect(send).toHaveBeenCalledWith(
      '/storyboard-short 参考 [image 1] 做成短片',
      [{ imageId: 'ref', dataUrl: 'data:image/png;base64,aGk=' }],
      'video',
    )
  })

  it('技能没写简介时次行退回 description，并去掉开头的「何时用：」', async () => {
    render()
    await settle()
    chooseOption('创作类型：图片', '视频')
    await settle()

    type('/image')
    const option = [...host.querySelectorAll<HTMLElement>('[role="option"]')][0]
    expect(option).toBeDefined()
    expect(option!.textContent).toContain('让一张已有的图动起来。')
    expect(option!.textContent).not.toContain('何时用：')
    expect(option!.querySelector('[data-skill-icon="image-play"]')).not.toBeNull()
  })

  it('只打一个 `/` 就列出这个 mode 的全部技能', async () => {
    render()
    await settle()
    chooseOption('创作类型：图片', '视频')
    await settle()

    type('/')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2)
  })

  it('草稿里已经有图片引用时，打 `/` 照样弹得出来', async () => {
    // `@` 与 `/` 共用可见文本那一套光标坐标；各用一套的话有胶囊的草稿就会算错位置。
    const session = agentDraft(null)
    session.update((draft) => ({
      ...draft,
      prompt: '/story 参考 @图1',
      references: [{ id: 'img-1', dataUrl: 'data:image/png;base64,aGk=' }],
    }))
    render()
    await settle()
    chooseOption('创作类型：图片', '视频')
    await settle()

    // 光标停在命令名末尾（可见文本的第 6 位）。
    document.dispatchEvent(new Event('selectionchange'))
    const el = editor()
    el.textContent = '/story'
    act(() => {
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(
      [...host.querySelectorAll<HTMLElement>('[role="option"]')].some((one) =>
        one.textContent?.includes('分镜短片'),
      ),
    ).toBe(true)
  })

  it('图片轮没有技能时不弹任何候选', async () => {
    render()
    await settle()
    type('/story')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0)
  })
})
