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
import { getSlashTemplateQuery } from '../../features/library/lib/templates'
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
/** 调用方那一侧的写入口：外部改提示词不经过编辑器。 */
let setPrompt: (prompt: string) => void

function Harness({
  initial,
  labels = noImages,
  parseCommand,
  onKeyDown,
  slotValues,
  command,
  referenceIds,
}: {
  initial: string
  labels?: MentionLabelResolver
  parseCommand?: PromptEditorOptions['parseCommand']
  onKeyDown?: PromptEditorOptions['onKeyDown']
  slotValues?: PromptEditorOptions['slotValues']
  command?: PromptEditorOptions['command']
  referenceIds?: PromptEditorOptions['referenceIds']
}) {
  const [value, setValue] = useState(initial)
  const editor = usePromptEditor({
    value,
    labels,
    onChange: setValue,
    parseCommand,
    onKeyDown,
    slotValues,
    command,
    referenceIds,
  })
  api = editor
  setPrompt = setValue
  return <PromptEditor editor={editor} aria-label="提示词" />
}

interface StubClipboard {
  setData(type: string, value: string): void
  getData(type: string): string
}

/** 剪贴板只记按 MIME 分开的几份，正好够看清哪一份带了存储形态。 */
function stubClipboard(): StubClipboard {
  const data: Record<string, string> = {}
  return {
    setData: (type, value) => {
      data[type] = value
    },
    getData: (type) => data[type] ?? '',
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
  it('在句中打字：字落在光标处，光标跟着走，浏览器建的节点原样留着', () => {
    mount(<Harness initial="你好" />)
    const el = editor()
    el.focus()
    // 输入法的组字就挂在这个节点上：编辑器要是重画一次，节点换了对象，组字会当场断掉。
    const typing = el.firstChild as Text
    typeInto((target) => {
      typing.data = '你在好'
      setContentEditableCursor(target, 2)
    })

    expect(editor().textContent).toBe('你在好')
    expect(getContentEditableSelection(editor())).toEqual({ start: 2, end: 2 })
    expect(editor().firstChild).toBe(typing)
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

    // 调用方那一侧换了值，跟编辑器自己的回写无关。
    act(() => setPrompt('新提示词'))
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

  it('光标停在命令胶囊里不查询，句中的第二个 `/` 照常查询', () => {
    const prompt = '/skill 画 /portrait'
    mount(<Harness initial={prompt} command="/skill" parseCommand={getSlashTemplateQuery} />)

    caretAt(3)
    expect(api.query).toBeNull()

    caretAt(prompt.length)
    expect(api.query).toMatchObject({ kind: 'command', start: 9, query: 'portrait' })
  })
})

describe('提示词编辑器 · 复制粘贴', () => {
  /** 目标输入框条里有两张图。 */
  const twoImages: MentionLabelResolver = (index) => ['@图1', '@图2'][index] ?? null

  /** 把整段选中复制出来。 */
  function copyAll(): StubClipboard {
    const clipboard = stubClipboard()
    const source = editor()
    source.focus()
    act(() => setContentEditableSelection(source, { start: 0, end: api.visible.length }))
    fire(source, 'copy', clipboard)
    return clipboard
  }

  function copyOneMention(): StubClipboard {
    mount(<Harness initial={`前${MENTION_1}后`} labels={oneImage} referenceIds={['img-a']} />)
    return copyAll()
  }

  it('同一个输入框里复制再粘贴，引用还是引用；外部应用拿到的是可见标签', () => {
    const clipboard = copyOneMention()
    expect(clipboard.getData('text/plain')).toBe('前@图1后')

    mount(<Harness key="target" initial="" labels={oneImage} referenceIds={['img-a']} />)
    fire(editor(), 'paste', clipboard)

    const chip = editor().querySelector<HTMLElement>('.mention-tag')
    expect(chip?.dataset.mentionText).toBe(MENTION_1)
    expect(editor().textContent).toBe('前@图1后')
  })

  it('只选中一个胶囊时复制胶囊本身，两边的空白不跟着走', () => {
    const clipboard = stubClipboard()
    mount(<Harness initial={`前 ${MENTION_1} 后`} labels={oneImage} referenceIds={['img-a']} />)
    const source = editor()
    source.focus()
    // 双击胶囊或拖过它的边缘就是这个选区：胶囊连着两边的空格。
    act(() => setContentEditableSelection(source, { start: 1, end: '前 @图1 '.length }))
    fire(source, 'copy', clipboard)

    expect(clipboard.getData('text/plain')).toBe('@图1')

    mount(<Harness key="target" initial="" labels={oneImage} referenceIds={['img-a']} />)
    fire(editor(), 'paste', clipboard)

    expect(editor().textContent).toBe('@图1')
  })

  it('粘到另一个输入框时按图片身份重挂序号，不照搬序号', () => {
    const clipboard = copyOneMention()

    // 目标输入框的 1 号位是另一张图，复制走的那张排在 2 号位。
    mount(<Harness key="target" initial="" labels={twoImages} referenceIds={['img-b', 'img-a']} />)
    fire(editor(), 'paste', clipboard)

    const chip = editor().querySelector<HTMLElement>('.mention-tag')
    expect(chip?.dataset.mentionText).toBe(getSelectedImageMentionLabel(1))
    expect(editor().textContent).toBe('前@图2后')
  })

  it('目标输入框没有这张图时，引用降级成它复制时的文字', () => {
    const clipboard = copyOneMention()

    mount(<Harness key="target" initial="" labels={oneImage} referenceIds={['img-b']} />)
    fire(editor(), 'paste', clipboard)

    expect(editor().querySelector('.mention-tag')).toBeNull()
    expect(editor().textContent).toBe('前@图1后')
  })

  it('认不出的那一份应用内负载按纯文本粘', () => {
    const clipboard = stubClipboard()
    // 旧版本页面写的是哨兵原文，不是这一版的负载；认不出就得退回可见标签，不能把整次粘贴丢掉。
    clipboard.setData(PROMPT_CLIPBOARD_TYPE, `前${MENTION_1}后`)
    clipboard.setData('text/plain', '前@图1后')
    mount(<Harness initial="" labels={oneImage} referenceIds={['img-a']} />)
    fire(editor(), 'paste', clipboard)

    expect(editor().querySelector('.mention-tag')).toBeNull()
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

  it('整段上屏的 input 排在组字结束前：槽位在组字结束后变成胶囊，光标不动', () => {
    const typed = '画一只{颜色}'
    mount(<Harness initial="画一只" slotValues={{ 颜色: ['红'] }} />)
    const el = editor()
    el.focus()
    act(() => {
      el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    })
    // 有些输入法把整段上屏的 input 排在 compositionend 前面，那一次还带着组字标记。
    typeInto((target) => {
      target.textContent = typed
      setContentEditableCursor(target, typed.length)
    })
    act(() => {
      el.dispatchEvent(new Event('compositionend', { bubbles: true }))
    })

    expect(editor().querySelector<HTMLElement>('.slot-tag')?.dataset.slotName).toBe('颜色')
    expect(getContentEditableSelection(editor()).start).toBe(typed.length)
  })

  it('整段上屏的 input 排在组字结束后：上屏的字不会被旧提示词盖掉', () => {
    const typed = '画一只{颜色}'
    mount(<Harness initial="画一只" slotValues={{ 颜色: ['红'] }} />)
    const el = editor()
    el.focus()
    // 另一种顺序：浏览器先把上屏的字写进 DOM 再发 compositionend，input 最后才到。
    act(() => {
      el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el.textContent = typed
      setContentEditableCursor(el, typed.length)
      el.dispatchEvent(new Event('compositionend', { bubbles: true }))
    })
    // 浏览器最后补发的那一次 input：DOM 已经是上屏后的样子。
    typeInto(() => {})

    expect(editor().textContent).toBe(typed)
    expect(editor().querySelector<HTMLElement>('.slot-tag')?.dataset.slotName).toBe('颜色')
    expect(getContentEditableSelection(editor()).start).toBe(typed.length)
  })
})
