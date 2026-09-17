import { afterEach, describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES, setLocale } from '../../i18n'
import { isSeedNewProfileName, profileSeedNames } from '../../lib/profileSeedNames'

afterEach(async () => {
  await setLocale('zh-CN')
})

describe('配置档案的初值文案', () => {
  it('按当前界面语言取', async () => {
    expect(profileSeedNames().newProfile).toBe('新配置')
    expect(profileSeedNames().copyOf('工作')).toBe('工作（复制）')

    await setLocale('en')

    expect(profileSeedNames().newProfile).toBe('New profile')
    expect(profileSeedNames().defaultProfile).toBe('Default')
    expect(profileSeedNames().customProvider).toBe('Custom provider')
    expect(profileSeedNames().copyOf('Work')).toBe('Work (copy)')
  })

  it('任一支持语言的默认名都算没动过的新配置，与当前界面语言无关', async () => {
    const seeds = SUPPORTED_LOCALES.map((locale) => profileSeedNames(locale).newProfile)
    expect(new Set(seeds).size).toBe(SUPPORTED_LOCALES.length)

    for (const locale of SUPPORTED_LOCALES) {
      await setLocale(locale)
      for (const seed of seeds) expect(isSeedNewProfileName(seed)).toBe(true)
    }
  })

  it('用户自己起的名字不算', () => {
    expect(isSeedNewProfileName('我的配置')).toBe(false)
    expect(isSeedNewProfileName('新配置 2')).toBe(false)
    expect(isSeedNewProfileName('')).toBe(false)
  })
})
