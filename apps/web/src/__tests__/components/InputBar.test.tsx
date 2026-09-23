// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InputBar from '../../components/InputBar'
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

describe('首屏「画布」档的参数 chip', () => {
  /** 换一版 InputBar 挂上：beforeEach 已经挂了直出那一版。 */
  function remount(target: 'generate' | 'canvas'): void {
    act(() => root.unmount())
    host.remove()
    useStore.setState({ createTarget: target })
    mount(<InputBar inline />)
  }

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
