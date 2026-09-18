// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  getContentEditablePlainText,
  getContentEditableSelection,
  setContentEditableCursor,
  setContentEditableSelection,
} from '../../lib/promptEditorDom'
import { getSelectedImageMentionLabel } from '../../lib/promptImageMentions'

let editor: HTMLDivElement

afterEach(() => {
  editor?.remove()
  window.getSelection()?.removeAllRanges()
})

describe('rich mention selection', () => {
  it('keeps command and image offsets despite shorter titles and textless thumbnails', () => {
    editor = document.createElement('div')
    document.body.append(editor)
    const image = getSelectedImageMentionLabel(0)
    editor.innerHTML = `<span class="mention-tag" contenteditable="false" data-mention-text="/character-sheet" data-mention-label="/character-sheet"><span>角色设定</span></span> 用 <span class="mention-tag" contenteditable="false" data-mention-text="${image}" data-mention-label="@图1"><img alt=""></span> 继续`
    const at = '/character-sheet 用 @图1'.length
    setContentEditableCursor(editor, at)
    expect(getContentEditableSelection(editor)).toEqual({ start: at, end: at })
    const range = window.getSelection()!.getRangeAt(0)
    range.insertNode(document.createTextNode('，'))
    expect(getContentEditablePlainText(editor)).toBe(`/character-sheet 用 ${image}， 继续`)
  })

  it('selects and removes a thumbnail-only token without leaving an invisible reference', () => {
    editor = document.createElement('div')
    document.body.append(editor)
    const image = getSelectedImageMentionLabel(0)
    editor.innerHTML = `<span class="mention-tag" contenteditable="false" data-mention-text="${image}" data-mention-label="@图1"><img alt=""></span>`
    setContentEditableSelection(editor, { start: 0, end: 3 })
    expect(getContentEditableSelection(editor)).toEqual({ start: 0, end: 3 })
    window.getSelection()!.getRangeAt(0).deleteContents()
    expect(getContentEditablePlainText(editor)).toBe('')
  })
})
