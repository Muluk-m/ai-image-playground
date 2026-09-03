import { describe, expect, it } from 'vitest'
import {
  createMentionLabels,
  getAtImageQuery,
  getPromptMentionParts,
  getSelectedImageMentionLabel,
  getVisiblePrompt,
  insertImageMentionAtVisibleRange,
  isCursorInSelectedImageMention,
  remapImageMentionsForOrder,
  replaceImageMentionsForApi,
} from '../../lib/promptImageMentions'
import type { InputImage } from '../../types'

const images: InputImage[] = [
  { id: 'image-a', dataUrl: 'data:image/png;base64,a' },
  { id: 'image-b', dataUrl: 'data:image/png;base64,b' },
]

const labels = createMentionLabels(images)
const namedLabels = createMentionLabels(images, { 'image-b': '熊猫' })

describe('prompt image mentions', () => {
  it('detects @ query after the cursor', () => {
    expect(getAtImageQuery('参考 @图', 5)).toEqual({ start: 3, query: '图' })
  })

  it('detects @ query even without current reference images', () => {
    expect(getAtImageQuery('参考 @熊', 5)).toEqual({ start: 3, query: '熊' })
  })

  it('keeps a completed image mention query selectable', () => {
    expect(getAtImageQuery('参考 @图2', 6)).toEqual({ start: 3, query: '图2' })
  })

  it('detects @ query in the middle of text without requiring whitespace prefix', () => {
    expect(getAtImageQuery('参考@', 3)).toEqual({ start: 2, query: '' })
  })

  it('replaces middle-text @ query with selected current reference image mention', () => {
    expect(insertImageMentionAtVisibleRange('参考@生成', 2, 3, 1, labels)).toEqual({
      prompt: `参考${getSelectedImageMentionLabel(1)}生成`,
      cursor: 5,
    })
  })

  it('does not add extra spaces around line breaks when inserting mentions', () => {
    expect(insertImageMentionAtVisibleRange('参考\n@\n生成', 3, 4, 0, labels)).toEqual({
      prompt: `参考\n${getSelectedImageMentionLabel(0)}\n生成`,
      cursor: 6,
    })
  })

  it('splits valid image mentions for tag rendering', () => {
    expect(
      getPromptMentionParts(`用${getSelectedImageMentionLabel(1)}的方式生成@图9`, labels),
    ).toEqual([
      { type: 'text', text: '用' },
      { type: 'mention', text: '@图2', imageIndex: 1 },
      { type: 'text', text: '的方式生成@图9' },
    ])
  })

  it('keeps manually typed mentions as plain text', () => {
    expect(getPromptMentionParts('用@图2的方式生成', labels)).toEqual([
      { type: 'text', text: '用@图2的方式生成' },
    ])
  })

  it('keeps mentions past the reference strip as plain text', () => {
    expect(getPromptMentionParts(`用${getSelectedImageMentionLabel(5)}生成`, labels)).toEqual([
      { type: 'text', text: '用@图6生成' },
    ])
  })

  it('detects cursor inside selected image mentions', () => {
    const prompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    expect(isCursorInSelectedImageMention(prompt, 6, labels)).toBe(true)
    expect(isCursorInSelectedImageMention(prompt, 3, labels)).toBe(false)
    expect(isCursorInSelectedImageMention(prompt, 7, labels)).toBe(false)
    expect(isCursorInSelectedImageMention('参考 @图2 生成', 6, labels)).toBe(false)
  })
})

describe('named mention labels', () => {
  it('shows the custom name instead of the index', () => {
    expect(getPromptMentionParts(`用${getSelectedImageMentionLabel(1)}生成`, namedLabels)).toEqual([
      { type: 'text', text: '用' },
      { type: 'mention', text: '@熊猫', imageIndex: 1 },
      { type: 'text', text: '生成' },
    ])
  })

  it('falls back to the index label for unnamed images', () => {
    expect(getVisiblePrompt(`用${getSelectedImageMentionLabel(0)}生成`, namedLabels)).toBe(
      '用@图1生成',
    )
  })

  it('measures visible offsets with the displayed name', () => {
    const prompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    expect(getVisiblePrompt(prompt, namedLabels)).toBe('参考 @熊猫 生成')
    expect(isCursorInSelectedImageMention(prompt, 6, namedLabels)).toBe(true)
    expect(isCursorInSelectedImageMention(prompt, 7, namedLabels)).toBe(false)
  })

  it('inserts after a named mention at the right visible offset', () => {
    const prompt = `${getSelectedImageMentionLabel(1)} 和 `

    expect(insertImageMentionAtVisibleRange(prompt, 6, 6, 0, namedLabels)).toEqual({
      prompt: `${getSelectedImageMentionLabel(1)} 和 ${getSelectedImageMentionLabel(0)}`,
      cursor: 9,
    })
  })

  it('measures the cursor with the labels shown after the insert', () => {
    const prompt = `${getSelectedImageMentionLabel(1)} 和 `
    const afterInsert = createMentionLabels(images, { 'image-b': '正义盟大殿' })

    expect(insertImageMentionAtVisibleRange(prompt, 6, 6, 0, labels, afterInsert)).toEqual({
      prompt: `${getSelectedImageMentionLabel(1)} 和 ${getSelectedImageMentionLabel(0)}`,
      cursor: 12,
    })
  })
})

describe('remapImageMentionsForOrder', () => {
  it('keeps mentions attached to the same image after reordering', () => {
    expect(
      remapImageMentionsForOrder(
        `用 ${getSelectedImageMentionLabel(1)} 参考 ${getSelectedImageMentionLabel(0)}`,
        images,
        [images[1], images[0]],
      ),
    ).toBe(`用 ${getSelectedImageMentionLabel(0)} 参考 ${getSelectedImageMentionLabel(1)}`)
  })

  it('marks removed image mentions as unavailable', () => {
    expect(
      remapImageMentionsForOrder(`用 ${getSelectedImageMentionLabel(1)}`, images, [images[0]]),
    ).toBe('用 @已移除图片')
  })

  it('keeps mentions attached when an image id is replaced with an equivalent id', () => {
    const replacement = { id: 'image-b-replacement', dataUrl: images[1].dataUrl }

    expect(
      remapImageMentionsForOrder(
        `用 ${getSelectedImageMentionLabel(1)}`,
        images,
        [images[0], replacement],
        { [images[1].id]: replacement.id },
      ),
    ).toBe(`用 ${getSelectedImageMentionLabel(1)}`)
  })
})

describe('replaceImageMentionsForApi', () => {
  it('replaces single mention', () => {
    expect(replaceImageMentionsForApi(`把 ${getSelectedImageMentionLabel(0)} 变蓝`)).toBe(
      '把 [image 1] 变蓝',
    )
  })

  it('replaces multiple mentions', () => {
    expect(
      replaceImageMentionsForApi(
        `把 ${getSelectedImageMentionLabel(1)} 的背景换到 ${getSelectedImageMentionLabel(0)} 上`,
      ),
    ).toBe('把 [image 2] 的背景换到 [image 1] 上')
  })

  it('does not replace manually typed mentions', () => {
    expect(replaceImageMentionsForApi('把 @图1 变蓝')).toBe('把 @图1 变蓝')
  })

  it('returns prompt unchanged when no mentions', () => {
    expect(replaceImageMentionsForApi('生成一只猫')).toBe('生成一只猫')
  })

  it('does not replace mentions outside the current image range', () => {
    expect(replaceImageMentionsForApi(`把 ${getSelectedImageMentionLabel(2)} 变蓝`, 2)).toBe(
      '把 @图3 变蓝',
    )
  })
})
