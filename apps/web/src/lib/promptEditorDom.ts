/**
 * contentEditable selection coordinates count mention labels, not their visual children.
 * A thumbnail or skill badge can supply data-mention-label without changing prompt offsets.
 */

function getMentionTagTextLength(el: Element) {
  return (el.getAttribute('data-mention-label') ?? el.textContent ?? '').length
}

function getNodeVisibleTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
    return getMentionTagTextLength(node)
  }
  return Array.from(node.childNodes).reduce(
    (sum, child) => sum + getNodeVisibleTextLength(child),
    0,
  )
}

function getVisibleOffsetBeforeNode(root: HTMLElement, target: Node): number {
  let offset = 0
  let found = false

  const walk = (node: Node) => {
    if (found) return
    if (node === target) {
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0
      return
    }
    if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
      offset += getMentionTagTextLength(node)
      return
    }
    node.childNodes.forEach(walk)
  }

  root.childNodes.forEach(walk)
  return offset
}

function getMentionTagForBoundary(root: HTMLElement, container: Node) {
  const el =
    container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement
  const tag = el?.closest('.mention-tag')
  return tag && root.contains(tag) ? tag : null
}

function getBoundaryOffsetInMention(tag: Element, container: Node, offset: number) {
  try {
    const range = document.createRange()
    range.selectNodeContents(tag)
    range.setEnd(container, offset)
    const length = tag.textContent?.length ?? 0
    return length ? (range.toString().length / length) * getMentionTagTextLength(tag) : 0
  } catch {
    return getMentionTagTextLength(tag)
  }
}

function getContentEditableBoundaryOffset(
  root: HTMLElement,
  container: Node,
  offset: number,
  edge: 'start' | 'end',
  collapsed: boolean,
) {
  if (container === root) {
    let visibleOffset = 0
    for (const child of Array.from(root.childNodes).slice(0, offset)) {
      visibleOffset += getNodeVisibleTextLength(child)
    }
    return visibleOffset
  }

  if (!root.contains(container)) {
    // 处理选区边界在输入框外部的情况（如 Ctrl+A）
    const position = root.compareDocumentPosition(container)
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 0
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return getNodeVisibleTextLength(root)

    // 如果是父容器，根据偏移量判断是在输入框前还是后
    if (container.contains(root)) {
      const children = Array.from(container.childNodes)
      const rootIndex = children.indexOf(root as any)
      return offset <= rootIndex ? 0 : getNodeVisibleTextLength(root)
    }
    return edge === 'start' ? 0 : getNodeVisibleTextLength(root)
  }

  const mentionTag = getMentionTagForBoundary(root, container)
  if (mentionTag) {
    const mentionStart = getVisibleOffsetBeforeNode(root, mentionTag)
    const mentionLength = getMentionTagTextLength(mentionTag)
    if (!collapsed) return edge === 'start' ? mentionStart : mentionStart + mentionLength
    const mentionOffset = getBoundaryOffsetInMention(mentionTag, container, offset)
    return mentionStart + (mentionOffset < mentionLength / 2 ? 0 : mentionLength)
  }

  if (container.nodeType === Node.TEXT_NODE) {
    return getVisibleOffsetBeforeNode(root, container) + offset
  }

  const element = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : null
  if (element) {
    let visibleOffset = element === root ? 0 : getVisibleOffsetBeforeNode(root, element)
    for (const child of Array.from(element.childNodes).slice(0, offset)) {
      visibleOffset += getNodeVisibleTextLength(child)
    }
    return visibleOffset
  }

  return getNodeVisibleTextLength(root)
}

/** 获取 contentEditable 中光标的纯文本偏移量 */
export function getContentEditableCursor(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return getNodeVisibleTextLength(el)
  try {
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return getNodeVisibleTextLength(el)
    return getContentEditableBoundaryOffset(
      el,
      range.startContainer,
      range.startOffset,
      'start',
      range.collapsed,
    )
  } catch {
    return getNodeVisibleTextLength(el)
  }
}

export function getContentEditableSelection(el: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    const end = getNodeVisibleTextLength(el)
    return { start: end, end }
  }
  try {
    const range = sel.getRangeAt(0)
    const start = getContentEditableBoundaryOffset(
      el,
      range.startContainer,
      range.startOffset,
      'start',
      range.collapsed,
    )
    const end = range.collapsed
      ? start
      : getContentEditableBoundaryOffset(el, range.endContainer, range.endOffset, 'end', false)
    return { start, end }
  } catch {
    const end = getNodeVisibleTextLength(el)
    return { start: end, end }
  }
}

export function getContentEditablePlainText(el: HTMLElement): string {
  let text = ''
  const appendNodeText = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
      text += node.dataset.mentionText ?? node.textContent ?? ''
      return
    }
    node.childNodes.forEach(appendNodeText)
  }
  el.childNodes.forEach(appendNodeText)
  return text.replace(/\r\n?/g, '\n')
}

export function syncMentionTagSelection(el: HTMLElement) {
  const tags = el.querySelectorAll<HTMLElement>('.mention-tag')
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    tags.forEach((tag) => tag.classList.remove('selected'))
    return
  }

  const range = sel.getRangeAt(0)
  if (range.collapsed) {
    tags.forEach((tag) => tag.classList.remove('selected'))
    return
  }

  tags.forEach((tag) => {
    let isSelected = false
    try {
      isSelected = range.intersectsNode(tag)
    } catch {
      isSelected = false
    }
    tag.classList.toggle('selected', isSelected)
  })
}

/** Resolve a label offset while treating each mention as one indivisible node. */
function contentEditablePosition(el: HTMLElement, offset: number): { node: Node; offset: number } {
  let remaining = Math.max(0, offset)
  const walk = (parent: Node): { node: Node; offset: number } | undefined => {
    for (let index = 0; index < parent.childNodes.length; index++) {
      const child = parent.childNodes[index]!
      if (child instanceof HTMLElement && child.classList.contains('mention-tag')) {
        const length = getMentionTagTextLength(child)
        if (remaining <= length) {
          return { node: parent, offset: index + (remaining < length / 2 ? 0 : 1) }
        }
        remaining -= length
      } else if (child.nodeType === Node.TEXT_NODE) {
        const length = child.textContent?.length ?? 0
        if (remaining <= length) return { node: child, offset: remaining }
        remaining -= length
      } else {
        const position = walk(child)
        if (position) return position
      }
    }
    return undefined
  }
  return walk(el) ?? { node: el, offset: el.childNodes.length }
}

export function setContentEditableSelection(
  el: HTMLElement,
  selection: { start: number; end: number },
) {
  const sel = window.getSelection()
  if (!sel) return
  const start = contentEditablePosition(el, selection.start)
  const end = contentEditablePosition(el, selection.end)
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Set the caret using the same mention-label coordinates as the query parsers. */
export function setContentEditableCursor(el: HTMLElement, offset: number) {
  setContentEditableSelection(el, { start: offset, end: offset })
}
