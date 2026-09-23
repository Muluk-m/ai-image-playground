import {
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { getSafeBoundingClientRect } from '../lib/domRect'
import {
  getContentEditableCursor,
  getContentEditablePlainText,
  getContentEditableSelection,
  setContentEditableCursor,
  setContentEditableSelection,
  syncMentionTagSelection,
} from '../lib/promptEditorDom'
import { buildPromptEditorHtml } from '../lib/promptEditorHtml'
import {
  getAtImageQuery,
  getMentionedImageIndexes,
  getPromptIndexFromVisibleIndex,
  getPromptMentionParts,
  getSelectedImageMentionLabel,
  getVisiblePrompt,
  isCursorInSelectedImageMention,
  type MentionLabelResolver,
} from '../lib/promptImageMentions'
import { getPromptSlotNames, type SlotValues } from '../lib/promptSlots'

/**
 * 应用内复制粘贴自带的那一份：引用按**图片身份**记，粘到别处按目标输入框的序号重挂，
 * 认不出的那张降级成复制时的显示文字。`text/plain` 只放可见标签，给外部应用看。
 * 粘贴优先认这一种，没有才退回纯文本。
 */
export const PROMPT_CLIPBOARD_TYPE = 'application/x-aip-prompt'

type PromptClipboardPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly imageId: string; readonly label: string }

/** 剪贴板里的这一段可能来自任何页面，逐项验过再用。 */
function readClipboardParts(raw: string): readonly PromptClipboardPart[] | null {
  if (!raw) return null
  let parts: unknown
  try {
    parts = (JSON.parse(raw) as { parts?: unknown } | null)?.parts
  } catch {
    return null
  }
  if (!Array.isArray(parts)) return null
  const valid = parts.every((part: Partial<PromptClipboardPart> | null) =>
    part?.type === 'text'
      ? typeof part.text === 'string'
      : part?.type === 'mention' &&
        typeof part.imageId === 'string' &&
        typeof part.label === 'string',
  )
  return valid ? (parts as PromptClipboardPart[]) : null
}

/** 引用按图片身份重挂到本输入框的序号；这里没有这张图就退回它复制时的文字。 */
function promptFromClipboard(
  parts: readonly PromptClipboardPart[],
  referenceIds: readonly string[],
): string {
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text
      const index = referenceIds.indexOf(part.imageId)
      return index >= 0 ? getSelectedImageMentionLabel(index) : part.label
    })
    .join('')
}

const NO_SLOT_VALUES: SlotValues = {}
const NO_REFERENCE_IDS: readonly string[] = []

/** 光标处正在打的 `@` 引用或 `/` 命令；菜单装什么归调用方。 */
export interface PromptEditorQuery {
  readonly kind: 'mention' | 'command'
  /** 触发字符在可见文本里的下标 */
  readonly start: number
  readonly query: string
  /** 光标相对输入框左边缘的像素偏移，用来吊菜单 */
  readonly left: number
}

export interface PromptEditorOptions {
  /** 存储形态的提示词：引用是哨兵，不是标签。 */
  readonly value: string
  readonly labels: MentionLabelResolver
  readonly onChange: (prompt: string) => void
  /**
   * 按引用序号排列的参考图身份。复制时随引用一起进剪贴板，粘贴时按它把序号重挂到本输入框——
   * 序号只在一个输入框里成立，照搬会悄悄指到另一张图上。
   */
  readonly referenceIds?: readonly string[]
  /** 槽位胶囊的 ×k 角标；不用槽位的输入框不必传。 */
  readonly slotValues?: SlotValues
  /** 开头要提升成胶囊的命令原文；什么算一条完整命令由调用方判断。 */
  readonly command?: string | null
  /** 命令胶囊的无障碍名。 */
  readonly commandLabel?: string
  /** 命令胶囊里放什么。 */
  readonly commandChip?: ReactNode
  /** `/` 查询的解析器；缺席即这个输入框没有命令菜单。 */
  readonly parseCommand?: (visible: string, cursor: number) => PromptEditorTrigger | null
  /** 引用胶囊里放什么；返回 null 即保留序号文本。 */
  readonly renderMention?: (imageIndex: number, label: string) => ReactNode
  /** 组字中的回车已经被吞掉，其余按键原样交还。 */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  /** 先让调用方看一眼剪贴板（例如收图片）；`preventDefault` 即这次粘贴归它。 */
  readonly onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void
  /** 用户动了一下提示词或光标；菜单据此重新打开。 */
  readonly onEdit?: () => void
}

export interface PromptEditorTrigger {
  readonly start: number
  readonly query: string
}

interface ChipTarget {
  readonly element: HTMLElement
  readonly key: string
  readonly kind: 'mention' | 'command'
  readonly imageIndex: number
  readonly label: string
}

export interface PromptEditorApi {
  /** 提示词渲染出来的那一串；光标坐标系就是在它上面数的。 */
  readonly visible: string
  readonly query: PromptEditorQuery | null
  /** 布局与命中测试归宿主（量高度、算胶囊位置），改内容一律走下面几个方法。 */
  readonly ref: RefObject<HTMLDivElement | null>
  /** 可见文本坐标系里的当前光标。 */
  cursor(): number
  /** 聚焦并把光标放到可见文本的某一位；DOM 写完才落实，不需要调用方自己排定时器。 */
  focusAt(offset: number): void
  /** 在当前选区插入一段文字。 */
  insertText(text: string): void
  /**
   * 按可见文本坐标换掉一段，`text` 是存储形态。`nextLabels` 给出换完以后编辑器会用的标签——
   * 附加素材会改变胶囊标签的长度，用旧标签算光标就会落偏。
   */
  replaceRange(start: number, end: number, text: string, nextLabels?: MentionLabelResolver): void
  blur(): void
  /** `<PromptEditor />` 的接线，调用方不用管。 */
  readonly bind: PromptEditorBinding
}

interface PromptEditorBinding {
  readonly portals: readonly ReactNode[]
  readonly onInput: (event: React.FormEvent<HTMLDivElement>) => void
  readonly onSelect: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  readonly onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  readonly onCopy: (event: ClipboardEvent<HTMLDivElement>) => void
  readonly onCut: (event: ClipboardEvent<HTMLDivElement>) => void
  readonly onCompositionStart: () => void
  readonly onCompositionEnd: () => void
}

/** 胶囊集合没变就不换引用，省掉一次 portal 重挂。 */
function sameChips(a: readonly ChipTarget[], b: readonly ChipTarget[]): boolean {
  return (
    a.length === b.length &&
    a.every((chip, index) => {
      const other = b[index]!
      return (
        chip.element === other.element &&
        chip.key === other.key &&
        chip.imageIndex === other.imageIndex &&
        chip.label === other.label
      )
    })
  )
}

/** 光标位置取不到时返回 null，让调用方沿用上一次——菜单不该因为一次空测量跳回左边。 */
function caretOffsetLeft(el: HTMLElement, range: Range | null): number | null {
  if (!range || typeof range.getBoundingClientRect !== 'function') return null
  const editorRect = getSafeBoundingClientRect(el)
  if (!editorRect) return null
  try {
    const caret = range.getBoundingClientRect()
    return caret.width === 0 && caret.height === 0 ? null : caret.left - editorRect.left
  } catch {
    return null
  }
}

function currentRange(): Range | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  try {
    return selection.getRangeAt(0)
  } catch {
    return null
  }
}

function clipboardText(data: DataTransfer, type: string): string {
  try {
    return data.getData(type) ?? ''
  } catch {
    return ''
  }
}

/**
 * 承载引用、槽位与命令胶囊的 contentEditable。提示词↔DOM 同步、回显跳过、选区跟踪、输入法、
 * 复制粘贴、胶囊提升与光标恢复都在这里；输入框自己只留菜单装什么与选中之后做什么。
 *
 * **可见文本的长度就是光标坐标系**（CONTEXT「引用」）：对外的每一个偏移量都按胶囊的显示标签数，
 * 不按存储形态数。
 */
export function usePromptEditor(options: PromptEditorOptions): PromptEditorApi {
  const { value, labels, command = null, commandLabel } = options
  const slotValues = options.slotValues ?? NO_SLOT_VALUES
  const ref = useRef<HTMLDivElement>(null)
  /** 用户刚打进去的那个值不回写 DOM，否则每敲一个字光标都会跳到末尾。 */
  const typedRef = useRef<string | null>(null)
  const composingRef = useRef(false)
  /** 程序化改动要落的光标；提示词写进 DOM 之后才谈得上落点，由同步 effect 落实。 */
  const caretRef = useRef<number | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [caret, setCaret] = useState({ start: 0, left: 0 })
  const [chips, setChips] = useState<readonly ChipTarget[]>([])
  /** 程序化改动可能写回同一个值（此时不重渲染），靠它把同步 effect 叫醒。 */
  const [revision, setRevision] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const typed = typedRef.current
    typedRef.current = null
    const pendingCaret = caretRef.current
    caretRef.current = null
    const { renderMention } = optionsRef.current
    // 命令胶囊缺席时必须重画：它是外部写进来的，或者刚打完最后一个空格。
    const commandMissing =
      Boolean(command) && !composingRef.current && !el.querySelector('[data-prompt-command]')
    if (pendingCaret == null && value === typed && !commandMissing) {
      setChips((current) =>
        current.every(({ element }) => el.contains(element))
          ? current
          : current.filter(({ element }) => el.contains(element)),
      )
      return
    }

    const selection = document.activeElement === el ? getContentEditableSelection(el) : null
    el.innerHTML = buildPromptEditorHtml(value, labels, slotValues)
    const next: ChipTarget[] = []
    for (const element of el.querySelectorAll<HTMLElement>('.mention-tag:not(.slot-tag)')) {
      const imageIndex = getMentionedImageIndexes(element.dataset.mentionText ?? '')[0]
      const label = element.textContent ?? ''
      if (imageIndex === undefined || !renderMention?.(imageIndex, label)) continue
      // 标签留在 data- 上：胶囊换成缩略图之后，光标仍按标签长度数。
      element.dataset.mentionLabel = label
      element.classList.add('agent-image-mention')
      element.setAttribute('aria-label', label)
      element.title = label
      element.textContent = ''
      next.push({ element, key: `mention-${next.length}`, kind: 'mention', imageIndex, label })
    }
    const first = el.firstChild
    if (
      command &&
      !composingRef.current &&
      first instanceof Text &&
      first.data.startsWith(command)
    ) {
      first.splitText(command.length)
      const element = document.createElement('span')
      element.contentEditable = 'false'
      // 胶囊里放的是调用方的组件，样式与查找都认 `data-prompt-command` 这一个钩子。
      element.className = 'mention-tag'
      element.dataset.mentionText = command
      element.dataset.mentionLabel = command
      element.dataset.promptCommand = command
      if (commandLabel) element.setAttribute('aria-label', commandLabel)
      first.replaceWith(element)
      next.push({ element, key: 'command', kind: 'command', imageIndex: -1, label: command })
    }
    setChips((current) => (sameChips(current, next) ? current : next))

    if (pendingCaret != null) {
      el.focus()
      setContentEditableCursor(el, pendingCaret)
    } else if (selection) {
      setContentEditableSelection(el, selection)
    }
    syncMentionTagSelection(el)
  }, [value, labels, slotValues, command, commandLabel, revision])

  // contentEditable 的 onSelect 不可靠，光标位置只能靠 selectionchange 跟。
  useEffect(() => {
    const onSelectionChange = () => {
      const el = ref.current
      if (!el) return
      const range = currentRange()
      if (!range) return
      let inside = false
      try {
        inside = range.intersectsNode(el)
      } catch {
        return
      }
      syncMentionTagSelection(el)
      if (!inside) return
      const { start } = getContentEditableSelection(el)
      const left = caretOffsetLeft(el, range)
      setCaret((current) =>
        current.start === start && (left == null || current.left === left)
          ? current
          : { start, left: left ?? current.left },
      )
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  const replaceRange = useCallback(
    (start: number, end: number, text: string, nextLabels?: MentionLabelResolver) => {
      const { value: prompt, labels: labelFor, onChange } = optionsRef.current
      const from = getPromptIndexFromVisibleIndex(prompt, start, labelFor)
      const to = getPromptIndexFromVisibleIndex(prompt, end, labelFor)
      const next = `${prompt.slice(0, from)}${text}${prompt.slice(to)}`
      const cursor = getVisiblePrompt(
        next.slice(0, from + text.length),
        nextLabels ?? labelFor,
      ).length
      typedRef.current = null
      caretRef.current = cursor
      setCaret((current) => ({ ...current, start: cursor }))
      setRevision((current) => current + 1)
      onChange(next)
    },
    [],
  )

  const focusAt = useCallback((offset: number) => {
    caretRef.current = offset
    setCaret((current) => ({ ...current, start: offset }))
    setRevision((current) => current + 1)
  }, [])

  const insertText = useCallback(
    (text: string) => {
      const el = ref.current
      const selection = el
        ? getContentEditableSelection(el)
        : { start: optionsRef.current.value.length, end: optionsRef.current.value.length }
      replaceRange(selection.start, selection.end, text)
    },
    [replaceRange],
  )

  const cursor = useCallback(() => {
    const el = ref.current
    return el ? getContentEditableCursor(el) : optionsRef.current.value.length
  }, [])

  const blur = useCallback(() => ref.current?.blur(), [])

  const trackCaret = (el: HTMLElement) => {
    const { start } = getContentEditableSelection(el)
    const left = caretOffsetLeft(el, currentRange())
    setCaret((current) => ({ start, left: left ?? current.left }))
    return start
  }

  const onInput = (event: React.FormEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    // 删掉最后一个字符后浏览器常留 <br> 或空 span，:empty 不再匹配 → placeholder 消失。
    // 只有引用的提示词没有 DOM 文本却仍有存储形态，所以按可见文本判空，不按 textContent。
    if (!getContentEditablePlainText(el) && el.innerHTML) el.innerHTML = ''
    const start = trackCaret(el)
    syncMentionTagSelection(el)
    const text = getContentEditablePlainText(el)
    // 手打出一个完整槽位时 DOM 必须重画一次，否则它永远不会变成胶囊。
    const structural =
      !composingRef.current &&
      getPromptSlotNames(text).join('\u0000') !== getPromptSlotNames(value).join('\u0000')
    typedRef.current = structural ? null : text
    if (structural) caretRef.current = start
    optionsRef.current.onChange(text)
    optionsRef.current.onEdit?.()
  }

  /**
   * 组字结束时以 DOM 里落下的那一段为准：组字期间的 input 都按回显跳过了，DOM 没重画过，
   * 而整段上屏的字未必已经进了提示词（有的输入法把那次 input 排在 compositionend 后面），
   * 按 value 重画会把刚上屏的字盖掉。重画这一次，刚上屏的槽位与命令才会变成胶囊。
   */
  const onCompositionEnd = () => {
    composingRef.current = false
    const el = ref.current
    if (!el) return
    const text = getContentEditablePlainText(el)
    typedRef.current = null
    caretRef.current = getContentEditableSelection(el).start
    setRevision((current) => current + 1)
    if (text !== optionsRef.current.value) optionsRef.current.onChange(text)
  }

  const onSelect = () => {
    const el = ref.current
    if (!el) return
    trackCaret(el)
    syncMentionTagSelection(el)
    optionsRef.current.onEdit?.()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 组字中的回车属于输入法：既不发送也不换行。
    if (event.key === 'Enter' && (composingRef.current || event.nativeEvent.isComposing)) {
      event.preventDefault()
      return
    }
    optionsRef.current.onKeyDown?.(event)
    // 换行由调用方决定往提示词里插什么，浏览器自己往 DOM 里塞 <br> 只会让两边对不上。
    if (event.key === 'Enter') event.preventDefault()
  }

  const writeClipboard = (event: ClipboardEvent<HTMLDivElement>) => {
    const { value: prompt, labels: labelFor, referenceIds = NO_REFERENCE_IDS } = optionsRef.current
    const selection = getContentEditableSelection(event.currentTarget)
    if (selection.start === selection.end) return null
    const from = getPromptIndexFromVisibleIndex(prompt, selection.start, labelFor)
    const to = getPromptIndexFromVisibleIndex(prompt, selection.end, labelFor)
    const canonical = prompt.slice(from, to)
    const selected = getPromptMentionParts(canonical, labelFor)
    // 双击或拖过胶囊边缘会把两边的空白一起选上：只选中一个胶囊时复制胶囊本身，
    // 别把空白也带走——两份负载都按这一份算，否则粘回来又多出那两个空格。
    const meaningful = selected.filter((part) => part.type === 'mention' || part.text.trim())
    const copied =
      meaningful.length === 1 && meaningful[0]?.type === 'mention' ? meaningful : selected
    // 序号换成图片身份：粘到别的输入框才认得出是同一张图，认不出就留下这一刻的显示文字。
    const parts = copied.map<PromptClipboardPart>((part) => {
      const imageId = part.type === 'mention' ? referenceIds[part.imageIndex] : undefined
      return imageId
        ? { type: 'mention', imageId, label: part.text }
        : { type: 'text', text: part.text }
    })
    event.clipboardData.setData(PROMPT_CLIPBOARD_TYPE, JSON.stringify({ parts }))
    event.clipboardData.setData('text/plain', copied.map((part) => part.text).join(''))
    event.preventDefault()
    return selection
  }

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    writeClipboard(event)
  }

  const onCut = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = writeClipboard(event)
    if (selection) replaceRange(selection.start, selection.end, '')
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    optionsRef.current.onPaste?.(event)
    if (event.defaultPrevented) return
    event.preventDefault()
    const parts = readClipboardParts(clipboardText(event.clipboardData, PROMPT_CLIPBOARD_TYPE))
    const text = parts
      ? promptFromClipboard(parts, optionsRef.current.referenceIds ?? NO_REFERENCE_IDS)
      : clipboardText(event.clipboardData, 'text/plain').replace(/\r\n?/g, '\n')
    if (!text) return
    const selection = getContentEditableSelection(event.currentTarget)
    replaceRange(selection.start, selection.end, text)
  }

  const visible = getVisiblePrompt(value, labels)
  const query = ((): PromptEditorQuery | null => {
    if (isCursorInSelectedImageMention(value, caret.start, labels)) return null
    const mention = getAtImageQuery(visible, caret.start)
    if (mention) {
      return { kind: 'mention', ...mention, left: caret.left }
    }
    // 已经提升成胶囊的命令是一个整体：光标停在它里面才不开菜单，句中后面的 `/` 照常查询。
    if (command && caret.start > 0 && caret.start <= command.length) return null
    const parsed = options.parseCommand?.(visible, caret.start)
    return parsed ? { kind: 'command', ...parsed, left: caret.left } : null
  })()

  const portals = chips.map((chip) =>
    createPortal(
      chip.kind === 'command'
        ? options.commandChip
        : options.renderMention?.(chip.imageIndex, chip.label),
      chip.element,
      chip.key,
    ),
  )

  return {
    visible,
    query,
    ref,
    cursor,
    focusAt,
    insertText,
    replaceRange,
    blur,
    bind: {
      portals,
      onInput,
      onSelect,
      onKeyDown,
      onPaste,
      onCopy,
      onCut,
      onCompositionStart: () => {
        composingRef.current = true
      },
      onCompositionEnd,
    },
  }
}

type PromptEditorProps = {
  editor: PromptEditorApi
  placeholder?: string
  /** 草稿还没读回来时不让编辑。 */
  disabled?: boolean
} & Omit<
  ComponentPropsWithoutRef<'div'>,
  | 'children'
  | 'contentEditable'
  | 'onInput'
  | 'onSelect'
  | 'onKeyDown'
  | 'onPaste'
  | 'onCopy'
  | 'onCut'
  | 'onCompositionStart'
  | 'onCompositionEnd'
>

export default function PromptEditor({
  editor,
  placeholder,
  disabled = false,
  ...rest
}: PromptEditorProps) {
  const { bind } = editor
  return (
    <>
      <div
        {...rest}
        ref={editor.ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={bind.onInput}
        onSelect={bind.onSelect}
        onKeyDown={bind.onKeyDown}
        onPaste={bind.onPaste}
        onCopy={bind.onCopy}
        onCut={bind.onCut}
        onCompositionStart={bind.onCompositionStart}
        onCompositionEnd={bind.onCompositionEnd}
      />
      {bind.portals}
    </>
  )
}
