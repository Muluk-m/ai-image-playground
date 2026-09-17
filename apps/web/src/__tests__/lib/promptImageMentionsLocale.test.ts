import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../i18n'
import {
  createMentionLabels,
  getImageMentionLabel,
  getPromptIndexFromVisibleIndex,
  getSelectedImageMentionLabel,
  getVisiblePrompt,
  imageMentionMatches,
  insertImageMentionAtVisibleRange,
  remapImageMentions,
  replaceImageMentionsForApi,
} from '../../lib/promptImageMentions'
import type { InputImage } from '../../types'

/**
 * 哨兵标记里的 `@图N` 是存储格式，胶囊上显示的标签才是界面文案。
 * 这里钉住两者已经分开：换界面语言只换显示，不换写进提示词的字节。
 */

const images = [{ id: 'a' }, { id: 'b' }] as InputImage[]

afterEach(async () => {
  await setLocale('zh-CN')
})

describe('哨兵是存储格式', () => {
  it('两种界面语言下写进提示词的内容逐字节相同', async () => {
    const zh = getSelectedImageMentionLabel(1)
    await setLocale('en')
    expect(getSelectedImageMentionLabel(1)).toBe(zh)
    expect(zh).toBe('⁣@图2⁤')
  })

  it('英文界面下插入引用，存的仍是中文哨兵，发给模型的仍是 [image N]', async () => {
    await setLocale('en')
    const labels = createMentionLabels(images)
    const { prompt } = insertImageMentionAtVisibleRange('put @ here', 4, 5, 0, labels)
    expect(prompt).toBe('put ⁣@图1⁤ here')
    expect(replaceImageMentionsForApi(prompt, 2)).toBe('put [image 1] here')
  })
})

describe('显示标签随界面语言变', () => {
  it('中文 @图1，英文 @Image 1', async () => {
    expect(getImageMentionLabel(0)).toBe('@图1')
    await setLocale('en')
    expect(getImageMentionLabel(0)).toBe('@Image 1')
  })

  it('素材名优先于序号标签，不受语言影响', async () => {
    await setLocale('en')
    const labels = createMentionLabels(images, { a: '红色水杯' })
    expect(labels(0)).toBe('@红色水杯')
    expect(labels(1)).toBe('@Image 2')
  })

  it('同一段提示词在英文下的可见文本与光标换算自洽', async () => {
    const prompt = `把${getSelectedImageMentionLabel(0)}放左边`
    await setLocale('en')
    const labels = createMentionLabels(images)
    const visible = getVisiblePrompt(prompt, labels)
    expect(visible).toBe('把@Image 1放左边')
    // 胶囊之后的第一个字「放」
    const after = visible.indexOf('放')
    expect(prompt[getPromptIndexFromVisibleIndex(prompt, after, labels)]).toBe('放')
    // 插入后的光标落在新胶囊的显示标签末尾
    const inserted = insertImageMentionAtVisibleRange('x @', 2, 3, 1, labels)
    expect(inserted.cursor).toBe('x @Image 2'.length)
  })
})

describe('@ 菜单匹配不分语言', () => {
  it.each(['zh-CN', 'en'] as const)('%s 下数字、图、image 都命中', async (locale) => {
    await setLocale(locale)
    expect(imageMentionMatches('2', 1)).toBe(true)
    expect(imageMentionMatches('图', 1)).toBe(true)
    expect(imageMentionMatches('图2', 1)).toBe(true)
    expect(imageMentionMatches('image', 1)).toBe(true)
    expect(imageMentionMatches('IMAGE2', 1)).toBe(true)
    expect(imageMentionMatches('img', 1)).toBe(false)
    expect(imageMentionMatches('图3', 1)).toBe(false)
  })
})

describe('被移除参考图的占位文字是初值文案', () => {
  it('按写入那一刻的界面语言写，之后不再变', async () => {
    const prompt = `看${getSelectedImageMentionLabel(0)}`
    expect(remapImageMentions(prompt, () => -1)).toBe('看@已移除图片')

    await setLocale('en')
    const written = remapImageMentions(prompt, () => -1)
    expect(written).toBe('看@removed image')

    await setLocale('zh-CN')
    // 已经是普通文字，重排不再碰它
    expect(remapImageMentions(written, () => -1)).toBe(written)
  })
})
