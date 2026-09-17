import i18next from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import { zhCN } from './locales/zh-CN'

// 把中文 catalog 的形状喂给 i18next：写错 key 或漏建 key 在 `pnpm typecheck` 就红，不用等运行时
// 把 key 原样渲染给用户。这段必须留在本文件里——放进独立的 .d.ts 就要靠各 tsconfig 的 include
// 捞进来，私有 overlay 的 tsconfig 没有捞，那个工程里的 key 就会退回无类型。
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: typeof zhCN
  }
}

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

/** 回退语言：英文缺 key 时显示中文，而不是把 key 本身漏给用户。 */
export const DEFAULT_LOCALE: AppLocale = 'zh-CN'

export type I18nNamespace = keyof typeof zhCN

export const I18N_NAMESPACES = Object.keys(zhCN) as I18nNamespace[]

const LOCALE_STORAGE_KEY = 'aip.locale'

function isSupported(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** `zh`、`zh-Hans-CN`、`en-GB` 这类 BCP-47 标签都要能落到我们支持的两个 locale 上。 */
export function normalizeLocale(tag: string | null | undefined): AppLocale | null {
  if (!tag) return null
  if (isSupported(tag)) return tag
  const primary = tag.toLowerCase().split('-')[0]
  if (primary === 'zh') return 'zh-CN'
  if (primary === 'en') return 'en'
  return null
}

function storedLocale(): AppLocale | null {
  try {
    return normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    // Safari 隐私模式下读 localStorage 会抛，不该因此挡住启动。
    return null
  }
}

export function detectLocale(): AppLocale {
  const stored = storedLocale()
  if (stored) return stored
  const candidates = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [])
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate)
    if (normalized) return normalized
  }
  return DEFAULT_LOCALE
}

/**
 * index.html 里的 lang 与标题写死的是中文，运行时按实际 locale 覆盖：屏读与 `:lang()` 才准，
 * 标签页标题也才是用户读得懂的那一种。必须在 `changeLanguage` 之后调，标题取的是当前语料。
 * 静态 meta 与 manifest 不动，那是给爬虫看的。
 */
function applyDocumentLocale(locale: AppLocale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.title = i18next.t('documentTitle')
}

/**
 * 中文品牌是「幕芽」加拉丁字标 Muvloom；品牌名本身已经是 Muvloom 的语言不再重复字标。
 * 写成显式的表而不是一条空字符串译文：语料里不允许空值，空值一律当漏翻。
 */
const BRAND_NEEDS_WORDMARK: Record<AppLocale, boolean> = { 'zh-CN': true, en: false }
export const BRAND_WORDMARK = 'Muvloom'

export function brandNeedsWordmark(locale: AppLocale = currentLocale()): boolean {
  return BRAND_NEEDS_WORDMARK[locale]
}

/**
 * 同步初始化，只带中文。i18next 默认把资源加载塞进 setTimeout，`initAsync: false`（v25 之前叫
 * `initImmediate`）让 init 在本次调用内完成，组件首帧就能拿到译文——`main.tsx` 与现有测试都是
 * import 完直接 render，异步初始化会让首帧渲染出 key 而不是文案。
 */
export function initI18n(): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources: { 'zh-CN': zhCN },
      lng: DEFAULT_LOCALE,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      ns: I18N_NAMESPACES,
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      initAsync: false,
      react: { useSuspense: false },
    })
  }
  return i18next
}

let englishBundle: Promise<void> | null = null

/**
 * 英文语料只在真的切过去时才拉。中文是默认语言又兼 fallback，必须随首屏一起到；英文全量
 * catalog 是同一个量级的净增重量，让只用中文的人也背着它不划算。
 */
export async function ensureLocaleLoaded(locale: AppLocale): Promise<void> {
  if (locale === DEFAULT_LOCALE) return
  if (!englishBundle) {
    englishBundle = import('./locales/en').then(({ en }) => {
      for (const [namespace, bundle] of Object.entries(en)) {
        i18next.addResourceBundle('en', namespace, bundle, true, true)
      }
    })
  }
  await englishBundle
}

export function currentLocale(): AppLocale {
  return normalizeLocale(i18next.resolvedLanguage ?? i18next.language) ?? DEFAULT_LOCALE
}

export async function setLocale(locale: AppLocale): Promise<void> {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // 存不下也要让本次切换生效，只是刷新后回到检测结果。
  }
  await ensureLocaleLoaded(locale)
  await i18next.changeLanguage(locale)
  applyDocumentLocale(locale)
}

/** 启动时按探测结果切一次。`main.tsx` 是 top-level await，能在首帧之前等英文 chunk 落地。 */
export async function bootstrapLocale(): Promise<void> {
  const locale = detectLocale()
  if (locale !== DEFAULT_LOCALE) {
    await ensureLocaleLoaded(locale)
    await i18next.changeLanguage(locale)
  }
  applyDocumentLocale(locale)
}

/**
 * 上游异常没有译文，只能原样透出。所以它永远是**插值参数**，不是文案本身——
 * 外层那句「××失败：{{reason}}」才是要翻译的部分。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

// 导入本模块即完成初始化：组件只从这里取 useTranslation，就不会出现「先渲染后初始化」。
initI18n()

export { i18next, useTranslation }
