import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { ROOT_LOCALE_SELECTION_SCRIPT } from '../localeSelection'

function select({
  languages = ['en-US'] as string[],
  language = undefined as string | undefined,
  stored = null as string | null,
  pathname = '/',
  userAgent = 'Mozilla/5.0',
  hidden = false,
  blockedStorage = false,
} = {}) {
  const replace = vi.fn()
  const style = { visibility: hidden ? 'hidden' : '' }
  runInNewContext(ROOT_LOCALE_SELECTION_SCRIPT, {
    document: { documentElement: { style } },
    navigator: { languages, language, userAgent },
    localStorage: {
      getItem: () => {
        if (blockedStorage) throw new Error('blocked')
        return stored
      },
    },
    location: { pathname, search: '?ref=x', hash: '', replace },
  })
  return { replace, style }
}

describe('landing locale selection', () => {
  it.each([
    {},
    { languages: ['en-GB', 'zh-CN'] },
    { languages: ['ja', 'en'] },
    { stored: 'en', languages: ['zh-CN'] },
    { blockedStorage: true },
    { languages: [], language: 'en-US' },
  ])('sends English visitors to /en/ before paint (%j)', (input) => {
    const { replace, style } = select(input)
    expect(style.visibility).toBe('hidden')
    expect(replace).toHaveBeenCalledExactlyOnceWith('/en/?ref=x')
  })

  it.each([
    { languages: ['zh-TW', 'en'] },
    { languages: ['ja'] },
    { languages: [] },
    { languages: [], language: 'zh-CN' },
    { stored: 'zh-CN' },
    { pathname: '/en/' },
    { pathname: '/pricing' },
    { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    { hidden: true },
  ])('keeps the Chinese page (%j)', (input) => {
    const { replace } = select(input)
    expect(replace).not.toHaveBeenCalled()
  })
})
