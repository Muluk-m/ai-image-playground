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

describe('英文语料拉不到', () => {
  afterEach(() => {
    vi.doUnmock('../../i18n/locales/en')
    vi.resetModules()
  })

  it('启动时退回随包的中文而不是卡住首帧，已保存的选择不动', async () => {
    vi.resetModules()
    vi.doMock('../../i18n/locales/en', () => {
      throw new Error('chunk gone')
    })
    const fresh = await import('../../i18n')
    localStorage.setItem('aip.locale', 'en')

    await expect(fresh.bootstrapLocale()).resolves.toBeUndefined()

    expect(fresh.currentLocale()).toBe('zh-CN')
    expect(document.title).toBe('幕芽 Muvloom · AI 图片与视频创作工作台')
    expect(localStorage.getItem('aip.locale')).toBe('en')
  })

  it('手动切换失败时不记下这次选择，之后还能重试', async () => {
    vi.resetModules()
    vi.doMock('../../i18n/locales/en', () => {
      throw new Error('chunk gone')
    })
    const fresh = await import('../../i18n')

    await expect(fresh.setLocale('en')).rejects.toThrow()
    expect(localStorage.getItem('aip.locale')).toBeNull()
    expect(fresh.currentLocale()).toBe('zh-CN')

    // 语料恢复后同一个实例上再切一次要能成功：失败的 promise 没有被缓存下来。
    vi.doUnmock('../../i18n/locales/en')
    await fresh.setLocale('en')
    expect(fresh.currentLocale()).toBe('en')
    expect(localStorage.getItem('aip.locale')).toBe('en')
  })
})
