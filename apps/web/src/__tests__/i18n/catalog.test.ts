import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, I18N_NAMESPACES, i18next, SUPPORTED_LOCALES } from '../../i18n'
import { en } from '../../i18n/locales/en'
import { zhCN } from '../../i18n/locales/zh-CN'

const catalogs: Record<string, Record<string, unknown>> = { 'zh-CN': zhCN, en }

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

type Catalog = Record<string, unknown>

function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix]
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node as Catalog).flatMap(([key, value]) =>
    leafPaths(value, prefix ? `${prefix}.${key}` : key),
  )
}

function leafValues(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]]
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node as Catalog).flatMap(([key, value]) =>
    leafValues(value, prefix ? `${prefix}.${key}` : key),
  )
}

/** 复数后缀是 locale 的属性而非翻译内容：中文只有 other，英文要 one + other。 */
function withoutPluralSuffix(path: string): string {
  return path.replace(PLURAL_SUFFIX, '')
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()
}

function catalog(locale: string, namespace: string): unknown {
  return catalogs[locale][namespace]
}

describe('i18n runtime', () => {
  it('initialises synchronously so the first render never shows raw keys', () => {
    expect(i18next.options.initAsync).toBe(false)
    expect(i18next.isInitialized).toBe(true)
  })

  it('rejects an undefined key at compile time', () => {
    // 结构化 key 的全部价值都押在这一条上：拼错或漏建的 key 必须在 `pnpm typecheck` 就红。
    // 若哪天类型增强失效，这个 @ts-expect-error 会变成「未使用的抑制」，typecheck 同样报错。
    // @ts-expect-error 这个 key 任何 catalog 都没有
    // 运行时 i18next 会把 namespace 前缀剥掉，原样回吐 key —— 正是不该让用户看见的东西。
    expect(i18next.t('auth:login.noSuchKey')).toBe('login.noSuchKey')
  })
})

describe('i18n catalogs', () => {
  it.each(
    I18N_NAMESPACES.map((namespace) => [namespace]),
  )('%s carries the same keys in every locale', (namespace) => {
    const baseline = new Set(leafPaths(catalog(DEFAULT_LOCALE, namespace)).map(withoutPluralSuffix))
    for (const locale of SUPPORTED_LOCALES) {
      const actual = new Set(leafPaths(catalog(locale, namespace)).map(withoutPluralSuffix))
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

  it.each(
    I18N_NAMESPACES.map((namespace) => [namespace]),
  )('%s keeps every interpolation placeholder across locales', (namespace) => {
    const baseline = new Map(
      leafValues(catalog(DEFAULT_LOCALE, namespace)).map(([path, value]) => [
        withoutPluralSuffix(path),
        placeholders(value),
      ]),
    )
    for (const locale of SUPPORTED_LOCALES) {
      for (const [path, value] of leafValues(catalog(locale, namespace))) {
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
    for (const namespace of I18N_NAMESPACES) {
      const pathsByLocale = new Map(
        SUPPORTED_LOCALES.map((locale) => [locale, leafPaths(catalog(locale, namespace))]),
      )
      // 复数 base 取两种语言的并集。只按各自的 base 找会漏掉一种不对称：一边写了
      // `x_one`/`x_other`，另一边写成无后缀的单条 `x`。这种情况前两条断言都抓不到
      // （剥掉后缀后 base 一样），但运行时缺后缀那一边查 `x_other` 会落空。
      const bases = new Set(
        [...pathsByLocale.values()]
          .flat()
          .filter((path) => PLURAL_SUFFIX.test(path))
          .map(withoutPluralSuffix),
      )
      for (const locale of SUPPORTED_LOCALES) {
        const categories = [
          ...new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
        ].sort()
        const paths = pathsByLocale.get(locale) ?? []
        for (const base of bases) {
          const present = paths
            .filter((path) => withoutPluralSuffix(path) === base)
            .map((path) => path.slice(base.length + 1))
            .sort()
          expect({ namespace, locale, base, present }).toEqual({
            namespace,
            locale,
            base,
            present: categories,
          })
        }
      }
    }
  })
})
