import i18next from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import authEn from './locales/en/auth.json'
import commonEn from './locales/en/common.json'
import errorsEn from './locales/en/errors.json'
import taskEn from './locales/en/task.json'
import authZh from './locales/zh-CN/auth.json'
import commonZh from './locales/zh-CN/common.json'
import errorsZh from './locales/zh-CN/errors.json'
import taskZh from './locales/zh-CN/task.json'

// 把中文 catalog 的形状喂给 i18next：写错 key 或漏建 key 在 `pnpm typecheck` 就红，不用等运行时
// 把 key 原样渲染给用户。这段必须留在本文件里——放进独立的 .d.ts 就要靠各 tsconfig 的 include
// 捞进来，私有 overlay 的 tsconfig 没有捞，那个工程里的 key 就会退回无类型。
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: {
      common: typeof commonZh
      auth: typeof authZh
      errors: typeof errorsZh
      task: typeof taskZh
    }
  }
}

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

/** 回退语言：英文缺 key 时显示中文，而不是把 key 本身漏给用户。 */
export const DEFAULT_LOCALE: AppLocale = 'zh-CN'

export const I18N_NAMESPACES = ['common', 'auth', 'errors', 'task'] as const

const LOCALE_STORAGE_KEY = 'aip.locale'

export const resources = {
  'zh-CN': { common: commonZh, auth: authZh, errors: errorsZh, task: taskZh },
  en: { common: commonEn, auth: authEn, errors: errorsEn, task: taskEn },
} as const

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

/** index.html 里写死的是 zh-CN，运行时按实际 locale 覆盖，屏读与 `:lang()` 才准。 */
function applyDocumentLocale(locale: AppLocale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

/**
 * 同步初始化。i18next 默认把资源加载塞进 setTimeout，`initAsync: false`（v25 之前叫
 * `initImmediate`）让 init 在本次调用内完成，组件首帧就能拿到译文——`main.tsx` 与现有测试
 * 都是 import 完直接 render，异步初始化会让首帧渲染出 key 而不是文案。
 */
export function initI18n(locale: AppLocale = detectLocale()): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources,
      lng: locale,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      ns: [...I18N_NAMESPACES],
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      initAsync: false,
      react: { useSuspense: false },
    })
  }
  applyDocumentLocale(locale)
  return i18next
}

export function currentLocale(): AppLocale {
  return normalizeLocale(i18next.resolvedLanguage ?? i18next.language) ?? DEFAULT_LOCALE
}

export function setLocale(locale: AppLocale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // 存不下也要让本次切换生效，只是刷新后回到检测结果。
  }
  void i18next.changeLanguage(locale)
  applyDocumentLocale(locale)
}

// 导入本模块即完成初始化：组件只从这里取 useTranslation，就不会出现「先渲染后初始化」。
initI18n()

export { i18next, useTranslation }
