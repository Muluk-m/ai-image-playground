import { afterEach, describe, expect, it } from 'vitest'
import {
  editableImageMentionText,
  imageMentionSpans,
  isOpaqueImageName,
  referenceTileLabel,
} from '../../../../features/agent/lib/imageMentions'
import { ensureLocaleLoaded, i18next } from '../../../../i18n'

const HASH = 'fdcfd93c4c098c0ce0123456789abcdef0123456789abcdef0123456789abcd'
const OTHER = '1d87bf6eca615d0b0123456789abcdef0123456789abcdef0123456789abcd'

afterEach(async () => {
  await i18next.changeLanguage('zh-CN')
})

describe('image mention spans', () => {
  it('numbers [image N] by reference index and leaves unknown markers in the text', () => {
    const text = '[image 2]这个换一身衣服，再参考[image 1]，不识别[image 3]'
    const spans = imageMentionSpans(text, [{ imageId: 'one' }, { imageId: 'two' }])

    expect(spans.map((span) => span.index)).toEqual([1, 0])
    expect(editableImageMentionText(text, [{ imageId: 'one' }, { imageId: 'two' }])).toBe(
      '图片 2这个换一身衣服，再参考图片 1，不识别[image 3]',
    )
  })

  it('replaces an exact @imageId and keeps the same number when it is mentioned twice', () => {
    const text = `@${HASH} 能不能把这个 换成 @${HASH}`
    const spans = imageMentionSpans(text, [{ imageId: HASH }])

    expect(spans).toEqual([
      { start: 0, end: HASH.length + 1, index: 0 },
      { start: text.lastIndexOf(`@${HASH}`), end: text.length, index: 0 },
    ])
    expect(editableImageMentionText(text, [{ imageId: HASH }])).toBe(
      '图片 1 能不能把这个 换成 图片 1',
    )
    expect(editableImageMentionText(text, [{ imageId: HASH }])).not.toContain(HASH)
  })

  it('matches the longer id when one image id is a prefix of another', () => {
    const text = '@abcdef 和 @abc'
    const spans = imageMentionSpans(text, [{ imageId: 'abc' }, { imageId: 'abcdef' }])

    expect(spans.map((span) => [span.index, text.slice(span.start, span.end)])).toEqual([
      [1, '@abcdef'],
      [0, '@abc'],
    ])
  })

  it('uses Image N after the locale switches', async () => {
    await ensureLocaleLoaded('en')
    await i18next.changeLanguage('en')
    expect(editableImageMentionText(`[image 1] bathroom`, [{ imageId: OTHER }])).toBe(
      'Image 1 bathroom',
    )
  })
})

describe('reference tile labels', () => {
  it('keeps a readable file name and hides a hash', () => {
    expect(isOpaqueImageName('海报底图', 'file_1')).toBe(false)
    expect(referenceTileLabel(0, '海报底图', 'file_1')).toBe('海报底图')
    expect(referenceTileLabel(1, '海报底图', 'file_1', '海报底图 2')).toBe('海报底图 2')
    expect(isOpaqueImageName(HASH, HASH)).toBe(true)
    expect(referenceTileLabel(0, HASH, HASH)).toBe('图片 1')
  })
})
