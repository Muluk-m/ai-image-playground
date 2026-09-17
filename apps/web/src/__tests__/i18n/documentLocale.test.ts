// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapLocale,
  brandNeedsWordmark,
  detectLocale,
  normalizeLocale,
  setLocale,
} from '../../i18n'

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await setLocale('zh-CN')
  localStorage.clear()
})

describe('标签页标题随界面语言', () => {
  it('切到英文是英文标题，切回中文恢复', async () => {
    await setLocale('en')
    expect(document.title).toBe('Muvloom · AI image and video studio')
    expect(document.documentElement.lang).toBe('en')

    await setLocale('zh-CN')
    expect(document.title).toBe('幕芽 Muvloom · AI 图片与视频创作工作台')
  })

  it('启动时探测到英文，标题取的是英文语料而不是还没切过去的中文', async () => {
    await setLocale('zh-CN')
    localStorage.clear()
    vi.stubGlobal('navigator', { languages: ['en-US'] })

    await bootstrapLocale()

    expect(document.title).toBe('Muvloom · AI image and video studio')
  })
})

describe('繁体中文浏览器落到简体', () => {
  it.each(['zh-TW', 'zh-HK', 'zh-Hant-TW', 'zh'])('%s', (tag) => {
    expect(normalizeLocale(tag)).toBe('zh-CN')
  })

  it('首选繁体、次选英文时仍是简体中文，不跳到英文', () => {
    vi.stubGlobal('navigator', { languages: ['zh-TW', 'en-US'] })
    expect(detectLocale()).toBe('zh-CN')
  })
})

describe('品牌字标', () => {
  it('中文在品牌名后带拉丁字标，英文品牌名已经是它，不再重复', () => {
    expect(brandNeedsWordmark('zh-CN')).toBe(true)
    expect(brandNeedsWordmark('en')).toBe(false)
  })
})
