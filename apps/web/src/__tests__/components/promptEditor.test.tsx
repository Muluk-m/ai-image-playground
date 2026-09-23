// @vitest-environment jsdom
import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import PromptEditor, {
  PROMPT_CLIPBOARD_TYPE,
  type PromptEditorApi,
  type PromptEditorOptions,
  usePromptEditor,
} from '../../components/PromptEditor'
import { getSlashSkillQuery } from '../../features/agent/lib/agentSkillMentions'
import {
  getContentEditableSelection,
  setContentEditableCursor,
  setContentEditableSelection,
} from '../../lib/promptEditorDom'
import {
  getSelectedImageMentionLabel,
  type MentionLabelResolver,
} from '../../lib/promptImageMentions'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MENTION_1 = getSelectedImageMentionLabel(0)
/** 这个输入框一张参考图都没有。 */
const noImages: MentionLabelResolver = () => null
/** 一张图的胶囊标签；可见文本按它计长，光标坐标系也是它。 */
const oneImage: MentionLabelResolver = (index) => (index === 0 ? '@图1' : null)

let host: HTMLDivElement
let root: Root
/** 最近一次渲染交出来的编辑器把手。 */
let api: PromptEditorApi

function Harness({
  initial,
  labels = noImages,
  parseCommand,
  onKeyDown,
  slotValues,
}: {
  initial: string
  labels?: MentionLabelResolver
  parseCommand?: PromptEditorOptions['parseCommand']
  onKeyDown?: PromptEditorOptions['onKeyDown']
  slotValues?: PromptEditorOptions['slotValues']
}) {
  const [value, setValue] = useState(initial)
  const editor = usePromptEditor({
    value,
    labels,
    onChange: setValue,
    parseCommand,
    onKeyDown,
    slotValues,
  })
  api = editor
  return <PromptEditor editor={editor} aria-label="提示词" />
}

/** 剪贴板只记按 MIME 分开的几份，正好够看清哪一份带了存储形态。 */
function stubClipboard() {
  const data: Record<string, string> = {}
  return {
    setData: (type: string, value: string) => {
      data[type] = value
    },
    getData: (type: string) => data[type] ?? '',
  }
}

function fire(el: HTMLElement, type: string, clipboardData: unknown): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  act(() => {
    el.dispatchEvent(event)
  })
}

function mount(node: ReactNode): void {
  act(() => root.render(node))
}

function editor(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[contenteditable]')
  if (!el) throw new Error('no contenteditable editor')
  return el
}

/** 模拟一次真实输入：浏览器先改 DOM，再派发 input。 */
function typeInto(mutate: (el: HTMLElement) => void): void {
  const el = editor()
  act(() => {
    mutate(el)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('提示词编辑器 · 提示词与 DOM 同步', () => {
  it('打字时不重写光标底下的 DOM', () => {
    mount(<Harness initial="" />)

    typeInto((el) => {
      el.innerHTML = '<span data-browser-node="1">你好</span>'
    })

    expect(editor().querySelector('[data-browser-node]')).not.toBeNull()
  })

  it('外部写进来的提示词在一次空转输入之后仍会渲染', () => {
    mount(<Harness initial="" />)
    typeInto((el) => {
      el.textContent = '旧提示词'
    })
    // 中文输入法、删了再打同一个字、粘贴同样的文本都会走到这一步：input 派发了，但纯文本没变。
    typeInto((el) => {
      el.textContent = '旧提示词'
    })

    act(() => api.replaceRange(0, '旧提示词'.length, '新提示词'))
    expect(editor().textContent).toBe('新提示词')
  })

  it('引用渲染成胶囊，可见文本用的是显示标签', () => {
    mount(<Harness initial={`前${MENTION_1}后`} labels={oneImage} />)

    const chip = editor().querySelector<HTMLElement>('.mention-tag')
    expect(chip?.textContent).toBe('@图1')
    expect(chip?.dataset.mentionText).toBe(MENTION_1)
    expect(editor().textContent).toBe('前@图1后')
  })

  it('手打出一个完整槽位就地变成胶囊，光标留在原处', () => {
    mount(<Harness initial="" slotValues={{ 颜色: ['红', '蓝'] }} />)
    editor().focus()
    typeInto((el) => {
      el.textContent = '画一只{颜色}猫'
      setContentEditableCursor(el, '画一只{颜色}'.length)
    })

    const chip = editor().querySelector<HTMLElement>('.slot-tag')
    expect(chip?.dataset.slotName).toBe('颜色')
    expect(chip?.dataset.slotCount).toBe('×2')
    expect(getContentEditableSelection(editor()).start).toBe('画一只{颜色}'.length)
  })
})

describe('提示词编辑器 · 光标', () => {
  it('程序化插入之后光标落在新文字后面', () => {
    mount(<Harness initial="你好" />)
    const el = editor()
    el.focus()
    setContentEditableCursor(el, 1)

    act(() => api.insertText('世界'))

    expect(editor().textContent).toBe('你世界好')
    expect(getContentEditableSelection(editor())).toEqual({ start: 3, end: 3 })
    expect(document.activeElement).toBe(editor())
  })
})

describe('提示词编辑器 · 查询', () => {
  /** 把光标放到可见文本的某一位，走一次真实的 selectionchange。 */
  function caretAt(offset: number): void {
    const el = editor()
    el.focus()
    act(() => {
      setContentEditableCursor(el, offset)
      document.dispatchEvent(new Event('selectionchange'))
    })
  }

  it('打到一半的 `@` 报成引用查询', () => {
    mount(<Harness initial="把 @图" />)
    caretAt('把 @图'.length)

    expect(api.query).toMatchObject({ kind: 'mention', start: 2, query: '图' })
  })

  it('光标落在已经选中的引用里就不再查询', () => {
    mount(<Harness initial={`${MENTION_1}的背景`} labels={oneImage} />)
    caretAt(2)

    expect(api.query).toBeNull()
  })

  it('命令查询交给调用方的解析器', () => {
    mount(<Harness initial="/story" parseCommand={getSlashSkillQuery} />)
    caretAt('/story'.length)

    expect(api.query).toMatchObject({ kind: 'command', start: 0, query: 'story' })
  })

  it('同时够得上两种时引用优先：一次只开一个菜单', () => {
    mount(<Harness initial="/story @" parseCommand={getSlashSkillQuery} />)
    caretAt('/story @'.length)

    expect(api.query).toMatchObject({ kind: 'mention', query: '' })
  })
})

describe('提示词编辑器 · 复制粘贴', () => {
  it('应用内复制再粘贴，引用还是引用；外部应用拿到的是可见标签', () => {
    const clipboard = stubClipboard()
    mount(<Harness initial={`前${MENTION_1}后`} labels={oneImage} />)
    const source = editor()
    source.focus()
    act(() => setContentEditableSelection(source, { start: 0, end: '前@图1后'.length }))
    fire(source, 'copy', clipboard)

    expect(clipboard.getData('text/plain')).toBe('前@图1后')
    expect(clipboard.getData(PROMPT_CLIPBOARD_TYPE)).toBe(`前${MENTION_1}后`)

    mount(<Harness key="target" initial="" labels={oneImage} />)
    fire(editor(), 'paste', clipboard)

    const chip = editor().querySelector<HTMLElement>('.mention-tag')
    expect(chip?.dataset.mentionText).toBe(MENTION_1)
    expect(editor().textContent).toBe('前@图1后')
  })

  it('外部来的纯文本按可见文本落在选区上', () => {
    const clipboard = stubClipboard()
    clipboard.setData('text/plain', '木纹\r\n桌面')
    mount(<Harness initial="把它换成" />)
    const el = editor()
    el.focus()
    act(() => setContentEditableCursor(el, '把它换成'.length))
    fire(el, 'paste', clipboard)

    expect(editor().textContent).toBe('把它换成木纹\n桌面')
  })
})

describe('提示词编辑器 · 输入法', () => {
  it('组字中的回车既不换行，也不交给调用方', () => {
    const keys: string[] = []
    mount(<Harness initial="你好" onKeyDown={(event) => keys.push(event.key)} />)
    const el = editor()
    act(() => {
      el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })

    expect(keys).toEqual([])
    expect(editor().textContent).toBe('你好')
  })

  it('组字结束之后的回车照常交给调用方', () => {
    const keys: string[] = []
    mount(<Harness initial="你好" onKeyDown={(event) => keys.push(event.key)} />)
    const el = editor()
    act(() => {
      el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el.dispatchEvent(new Event('compositionend', { bubbles: true }))
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })

    expect(keys).toEqual(['Enter'])
  })
})
