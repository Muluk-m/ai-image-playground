// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InputBar from '../../components/InputBar'
import { useLibraryStore } from '../../features/library/store'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import { setChannels } from '../../lib/channels/channelStore'
import type { PublicChannel } from '../../lib/channels/types'
import { getAllImageIds, putImage } from '../../lib/db'
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

/** chip 的 title 是 `label` 或 `label: value`，按前缀找。 */
function chip(label: string): Element | null {
  return host.querySelector(`[title="${label}"], [title^="${label}: "]`)
}

function editor(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[contenteditable]')
  if (!el) throw new Error('no contenteditable editor')
  return el
}

/** 模拟一次真实输入：浏览器先改 DOM，再派发 input。 */
function type(html: string): void {
  const el = editor()
  act(() => {
    el.innerHTML = html
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 换一版 InputBar 挂上：beforeEach 已经挂了直出那一版。 */
function remount(target: 'generate' | 'canvas'): void {
  act(() => root.unmount())
  host.remove()
  useStore.setState({ createTarget: target })
  mount(<InputBar inline />)
}

describe('InputBar 编辑器与 prompt 的同步', () => {
  it('外部设置的 prompt 在一次空转输入之后仍会写进编辑器', () => {
    type('旧提示词')
    expect(useStore.getState().prompt).toBe('旧提示词')

    // 中文输入法、删了再打同一个字、粘贴同样的文本都会走到这一步：input 派发了，但纯文本没变。
    type('旧提示词')

    act(() => useStore.getState().setPrompt('新提示词'))
    expect(editor().textContent).toBe('新提示词')
  })

  it('打字时不重写光标底下的 DOM', () => {
    type('<span data-browser-node="1">你好</span>')
    expect(useStore.getState().prompt).toBe('你好')
    expect(editor().querySelector('[data-browser-node]')).toBeTruthy()
  })

  it('打出一个完整槽位仍会渲染成 chip', () => {
    type('画一只{颜色}猫')
    const chip = editor().querySelector('.slot-tag')
    expect(chip?.getAttribute('data-slot-name')).toBe('颜色')
  })
})

describe('首屏「画布」档的参数 chip', () => {
  it('直出档摆着张数与「更多」', () => {
    remount('generate')
    expect(chip('数量')).not.toBeNull()
    expect(chip('更多')).not.toBeNull()
  })

  it('交给智能体时只留模型与画幅：张数、质量、格式都由它自己定', () => {
    remount('canvas')
    // 画幅还在：比例 / 尺寸这一档用户说了算。
    expect(chip('比例') ?? chip('尺寸')).not.toBeNull()
    expect(chip('数量')).toBeNull()
    expect(chip('更多')).toBeNull()
    expect(chip('质量')).toBeNull()
    expect(chip('格式')).toBeNull()
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

    expect(chip('比例')).not.toBeNull()
    expect(chip('分辨率')).not.toBeNull()
    expect(chip('思考')).toBeNull()
    expect(chip('更多')).toBeNull()
    expect(chip('数量')).toBeNull()
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
