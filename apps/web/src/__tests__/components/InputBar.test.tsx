// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
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

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({ prompt: '' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<InputBar />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

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
