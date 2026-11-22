import { describe, expect, it } from 'vitest'
import en from '../../../features/billing/locales/en.json'
import zhCN from '../../../features/billing/locales/zh-CN.json'

/**
 * overlay 的语料不在公开树 `catalog.test.ts` 的扫描范围里——那份只遍历 `I18N_NAMESPACES`
 * 里的公开命名空间，看不见 `billing`。而英文漏翻一条不会报错，只会静默回退成中文，
 * 这三条断言是唯一能抓住它的地方。
 */
const DEFAULT_LOCALE = 'zh-CN'

const CATALOGS: Record<string, unknown> = { 'zh-CN': zhCN, en }

const LOCALES = Object.keys(CATALOGS)

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function leafValues(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]]
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leafValues(value, prefix ? `${prefix}.${key}` : key),
  )
}

function leafPaths(node: unknown): string[] {
  return leafValues(node).map(([path]) => path)
}

/** 复数后缀是 locale 的属性而非翻译内容：中文只有 other，英文要 one + other。 */
function withoutPluralSuffix(path: string): string {
  return path.replace(PLURAL_SUFFIX, '')
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
}

describe('billing catalog', () => {
  it('carries the same keys in every locale', () => {
    const baseline = new Set(leafPaths(CATALOGS[DEFAULT_LOCALE]).map(withoutPluralSuffix))

    for (const locale of LOCALES) {
      const actual = new Set(leafPaths(CATALOGS[locale]).map(withoutPluralSuffix))

      expect({ locale, missing: [...baseline].filter((key) => !actual.has(key)) }).toEqual({
        locale,
        missing: [],
      })
      expect({ locale, extra: [...actual].filter((key) => !baseline.has(key)) }).toEqual({
        locale,
        extra: [],
      })
    }
  })

  it('keeps every interpolation placeholder across locales', () => {
    const baseline = new Map<string, string[]>(
      leafValues(CATALOGS[DEFAULT_LOCALE]).map(
        ([path, value]) => [withoutPluralSuffix(path), placeholders(value)] as const,
      ),
    )

    for (const locale of LOCALES) {
      for (const [path, value] of leafValues(CATALOGS[locale])) {
        const expected = baseline.get(withoutPluralSuffix(path))
        if (!expected) continue
        expect({ locale, path, placeholders: placeholders(value) }).toEqual({
          locale,
          path,
          placeholders: expected,
        })
      }
    }
  })

  it('declares every plural category each locale actually uses', () => {
    // 取所有 locale 的并集：只有一边写了复数、另一边留着无后缀单条，同样要报出来。
    const pluralBases = new Set(
      LOCALES.flatMap((locale) =>
        leafPaths(CATALOGS[locale])
          .filter((path) => PLURAL_SUFFIX.test(path))
          .map(withoutPluralSuffix),
      ),
    )
    expect(pluralBases.size).toBeGreaterThan(0)

    for (const locale of LOCALES) {
      const categories = [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort()
      const paths = leafPaths(CATALOGS[locale])

      for (const base of pluralBases) {
        const present = paths
          .filter((path) => withoutPluralSuffix(path) === base)
          .map((path) => path.slice(base.length + 1))
          .sort()

        expect({ locale, base, present }).toEqual({ locale, base, present: categories })
      }
    }
  })
})
