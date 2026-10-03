// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../features/agent/lib/useAgentSkills', () => ({
  useAgentSkills: () => [
    { name: 'create-look', title: '建模板', description: '', icon: 'wand', summary: '' },
  ],
}))

import InputBar from '../../components/InputBar'
import { useActiveLook } from '../../features/library/lib/activeLook'
import { cancelLookSubmission, useLookSubmission } from '../../features/library/lib/lookSubmit'
import { useLibraryStore } from '../../features/library/store'
import {
  createDefaultOpenAIByokProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from '../../lib/apiProfiles'
import { setChannels } from '../../lib/channels/channelStore'
import type { PublicChannel } from '../../lib/channels/types'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
import { getAllImageIds, putImage } from '../../lib/db'
import { getContentEditablePlainText, setContentEditableCursor } from '../../lib/promptEditorDom'
import { useStore } from '../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
/** 换过 profile 的用例不能污染同文件后面的：每个用例都从这份起。 */
const INITIAL_SETTINGS = useStore.getState().settings

function mount(node: ReactNode): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(node))
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ prompt: '', createTarget: 'generate', settings: INITIAL_SETTINGS })
  mount(<InputBar />)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** 生成设置 chip：aria-label 是「生成设置: 摘要」。 */
function settingsChip(): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>('[aria-label^="生成设置: "]')
  if (!el) throw new Error('no settings chip')
  return el
}

/** 点开生成设置卡片（Radix 浮层挂在 body 上），返回按分组名找控件的函数。 */
function openSettings(): (label: string) => Element | null {
  act(() => {
    settingsChip().click()
  })
  return (label) => document.body.querySelector(`[role="group"][aria-label="${label}"]`)
}

function editor(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[contenteditable]')
  if (!el) throw new Error('no contenteditable editor')
  return el
}

/** 模拟一次真实输入：浏览器先改 DOM、把光标留在打完的位置，再派发 input。 */
function type(html: string): void {
  const el = editor()
  act(() => {
    el.innerHTML = html
    el.focus()
    setContentEditableCursor(el, getContentEditablePlainText(el).length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 换一版 InputBar 挂上：beforeEach 已经挂了直出那一版。 */
function remount(target: 'generate' | 'chat' | 'canvas'): void {
  act(() => root.unmount())
  host.remove()
  useStore.setState({ createTarget: target })
  mount(<InputBar inline />)
}

/** 编辑器本身（提示词↔DOM、回显跳过、胶囊提升）由 `promptEditor.test.tsx` 在接缝上守着。 */
describe('生成输入框的回车', () => {
  function pressEnter({ composing }: { composing: boolean }): void {
    const el = editor()
    act(() => {
      if (composing) el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
  }

  beforeEach(() => {
    useStore.getState().setSettings({ enterSubmit: false })
    type('你好')
  })

  it('组字中的回车什么都不做：既不发送也不换行', () => {
    pressEnter({ composing: true })
    expect(useStore.getState().prompt).toBe('你好')
  })

  it('组字结束后的回车照常换行', () => {
    pressEnter({ composing: false })
    expect(useStore.getState().prompt).toBe('你好\n')
  })
})

describe('首屏的生成设置', () => {
  it('直出档：摘要带张数，卡片里有数量、质量与格式', () => {
    remount('generate')
    expect(settingsChip().getAttribute('aria-label')).toContain('1 张')
    const group = openSettings()
    expect(group('比例')).not.toBeNull()
    expect(group('数量')).not.toBeNull()
    expect(group('格式')).not.toBeNull()
  })

  it('交给智能体时只留画幅：张数、质量、格式都由它自己定', () => {
    remount('canvas')
    expect(settingsChip().getAttribute('aria-label')).not.toContain('张')
    const group = openSettings()
    expect(group('比例')).not.toBeNull()
    expect(group('数量')).toBeNull()
    expect(group('质量')).toBeNull()
    expect(group('格式')).toBeNull()
  })

  it('对话创作与画布创作都走 Agent 输入，但保留各自入口', () => {
    remount('chat')
    expect(openSettings()('数量')).toBeNull()
    expect(editor().getAttribute('data-placeholder')).toContain('讨论思路')
    expect(useStore.getState().createTarget).toBe('chat')
  })

  it('选一格比例就写回对应尺寸，「恢复默认」回到智能比例', () => {
    remount('generate')
    const group = openSettings()
    const sixteenNine = [...(group('比例')?.querySelectorAll('button') ?? [])].find((one) =>
      one.textContent?.includes('16:9'),
    )
    expect(sixteenNine).toBeDefined()
    act(() => sixteenNine?.click())
    expect(useStore.getState().params.size).toBe('1280x720')
    const reset = [...document.body.querySelectorAll('button')].find(
      (one) => one.textContent === '恢复默认',
    )
    act(() => reset?.click())
    expect(useStore.getState().params.size).toBe('auto')
  })

  it('自定义宽高：改一边就提交完整尺寸，输入框不收起；被规整的值回显成实际尺寸', () => {
    remount('generate')
    const group = openSettings()
    const custom = [...(group('比例')?.querySelectorAll('button') ?? [])].find((one) =>
      one.textContent?.includes('自定义'),
    )
    act(() => custom?.click())
    const width = () => document.body.querySelector<HTMLInputElement>('input[aria-label^="宽度"]')
    const setValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    act(() => {
      const input = width()!
      input.focus()
      setValue(input, '1024')
    })
    act(() => width()?.blur())
    expect(useStore.getState().params.size).toBe('1024x1024')
    // 恰好落在 1:1 预设上也不退出自定义，还能接着填高度。
    expect(width()).not.toBeNull()

    act(() => {
      const input = width()!
      input.focus()
      setValue(input, '99999')
    })
    act(() => width()?.blur())
    const size = useStore.getState().params.size
    expect(size).not.toBe('99999x1024')
    expect(width()?.value).toBe(size.split('x')[0])
    act(() => useStore.getState().setParams({ size: 'auto' }))
  })

  it('数量可选到上限，不止 1–4 张', () => {
    remount('generate')
    const ten = [...(openSettings()('数量')?.querySelectorAll('button') ?? [])].find(
      (one) => one.textContent === '10',
    )
    act(() => ten?.click())
    expect(useStore.getState().params.n).toBe(10)
    expect(settingsChip().getAttribute('aria-label')).toContain('10 张')
    act(() => useStore.getState().setParams({ n: 1 }))
  })

  it('Gemini 模型下留的是比例与分辨率，思考强度归智能体', () => {
    useStore.setState({
      settings: {
        ...useStore.getState().settings,
        activeProfileId: 'gemini-byok',
        profiles: [
          {
            id: 'gemini-byok',
            source: 'user-byok',
            name: 'Gemini',
            kind: 'gemini',
            baseUrl: 'https://example.com',
            apiKey: 'sk-x',
            models: ['gemini-3.1-flash-image'],
            selectedModelId: 'gemini-3.1-flash-image',
            preferences: { apiMode: 'images', timeout: 600, codexCli: false, apiProxy: false },
          },
        ],
      },
    })
    remount('canvas')

    const group = openSettings()
    expect(group('比例')).not.toBeNull()
    expect(group('分辨率')).not.toBeNull()
    expect(group('思考')).toBeNull()
    expect(group('数量')).toBeNull()
  })
})

describe('首屏「画布」档的参考图', () => {
  const PIXEL = 'data:image/png;base64,AAAA'
  const noEditChannel: PublicChannel = {
    id: 'no-edit',
    kind: 'openai-queue',
    label: 'NoEdit',
    models: [{ id: 'gen-only', label: 'Gen only', capabilities: ['generate'] }],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  beforeEach(() => {
    setChannels([noEditChannel])
    useStore.setState({
      inputImages: [],
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [
          {
            id: 'builtin-no-edit',
            source: 'builtin-edge',
            channelId: 'no-edit',
            selectedModelId: 'gen-only',
          },
        ],
        activeProfileId: 'builtin-no-edit',
      }),
    })
  })

  afterEach(() => {
    setChannels([])
    useLibraryStore.setState({ assets: [] })
  })

  /** 附图入口：能点时标题是「添加参考图……」，被拒时标题换成拒绝的理由。 */
  function attachButton(): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find(
      (button) => button.title.startsWith('添加参考图') || button.title.includes('不支持参考图'),
    )
    if (!found) throw new Error('没找到附图入口')
    return found
  }

  /** 素材从 IndexedDB 取回来再进条，等它落定。 */
  async function settleAttach(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (useStore.getState().inputImages.length > 0) return
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('模型不认参考图也附得上 `@` 素材：那几张是交给画布第一轮的，不归生图模型', async () => {
    const imageId = 'asset-image'
    await putImage({ id: imageId, dataUrl: PIXEL, source: 'upload', createdAt: 1 })
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    remount('canvas')

    type('@白')
    const option = host.querySelector('[role="option"]')
    if (!option) throw new Error('`@` 菜单里没有素材可选')
    await act(async () => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await settleAttach()

    expect(useStore.getState().inputImages.map((image) => image.id)).toEqual([imageId])
  })

  it('直出档同一个模型仍然拦着：附图入口自己说明为什么点不了', () => {
    remount('generate')

    expect(attachButton().title).toContain('不支持参考图')
  })

  it('这一把文件进不去就一张都不落盘：写进去的图谁也不会再用，只占地方', async () => {
    remount('generate')
    const before = await getAllImageIds()
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('没找到文件输入')
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'a.png', { type: 'image/png' })],
      configurable: true,
    })

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(useStore.getState().toast?.message).toContain('不支持参考图')
    expect(await getAllImageIds()).toEqual(before)
  })
})

describe('开头的 /技能 命令', () => {
  function setPrompt(prompt: string): void {
    act(() => useStore.setState({ prompt }))
  }

  it('画布档变成技能胶囊', () => {
    remount('canvas')
    setPrompt('/create-look 做个模板')
    expect(host.querySelector('[data-skill-name="create-look"]')).not.toBeNull()
  })

  it('生成档不认技能，也不许把命令当提示词拿去出图', () => {
    useStore.setState({
      settings: {
        ...useStore.getState().settings,
        activeProfileId: 'openai-byok',
        profiles: [
          {
            id: 'openai-byok',
            source: 'user-byok',
            name: 'OpenAI',
            kind: 'openai-compat',
            baseUrl: 'https://example.com',
            apiKey: 'sk-x',
            models: ['gpt-image-2'],
            selectedModelId: 'gpt-image-2',
            preferences: { apiMode: 'images', timeout: 600, codexCli: false, apiProxy: false },
          },
        ],
      },
    })
    remount('generate')
    const submit = () =>
      [...host.querySelectorAll('button')].find((one) => one.textContent?.trim() === '生成')

    setPrompt('做个模板')
    expect(submit()?.disabled).toBe(false)

    setPrompt('/create-look 做个模板')
    expect(host.querySelector('[data-skill-name]')).toBeNull()
    expect(submit()?.disabled).toBe(true)
  })
})

it('template preparation turns the send button into a click-only stop, even with a draft', async () => {
  await bootstrapClientCapabilities(false, '')
  const profile = createDefaultOpenAIByokProfile({ apiKey: 'test-key' })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
  try {
    act(() => {
      useStore.setState({
        prompt: '',
        inputImages: [],
        appMode: 'image',
        settings: normalizeSettings({
          ...DEFAULT_SETTINGS,
          profiles: [profile],
          activeProfileId: profile.id,
        }),
      })
      useActiveLook.getState().set({
        skillName: 'template',
        origin: 'builtin',
        name: 'Test',
        description: '',
        purpose: 'scene',
        model: profile.selectedModelId,
        size: '1024x1024',
        slotCount: 0,
        cover: null,
        references: [{ kind: 'url', url: '/required.png' }],
      })
    })
    const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.title.includes('生成') && !button.hasAttribute('aria-haspopup') && !button.disabled,
    )
    expect(send).toBeDefined()
    await act(async () => {
      send!.click()
    })
    expect(useLookSubmission.getState().submitting).toBe(true)
    expect(send!.textContent).toContain('取消')
    expect(send!.textContent).not.toContain('■')
    expect(send!.querySelector('svg')).not.toBeNull()
    type('new draft')
    // 输入框有字也照样能停。
    expect(send!.disabled).toBe(false)
    expect(send!.textContent).toContain('取消')
    // 回车既不取消也不另发一条。
    for (const enterSubmit of [true, false]) {
      act(() => useStore.getState().setSettings({ enterSubmit }))
      act(() => {
        editor().dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: !enterSubmit,
            bubbles: true,
            cancelable: true,
          }),
        )
      })
      expect(useLookSubmission.getState().submitting).toBe(true)
    }
    await act(async () => {
      send!.click()
    })
    expect(useLookSubmission.getState().submitting).toBe(false)
    expect(useStore.getState().tasks).toHaveLength(0)
  } finally {
    act(() => {
      cancelLookSubmission()
      useActiveLook.getState().set(null)
    })
    fetcher.mockRestore()
  }
})
