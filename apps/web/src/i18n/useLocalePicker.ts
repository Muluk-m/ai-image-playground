import { useCallback, useState } from 'react'
import { type AppLocale, currentLocale, setLocale, useTranslation } from './index'

export interface LocalePicker {
  /** 当前应当显示在下拉里的值。切换在途时是目标语言，不是还没变的当前语言。 */
  locale: AppLocale
  change: (next: AppLocale) => void
}

/**
 * 语言下拉的状态。
 *
 * `setLocale` 是异步的（英文语料要先落地），而 `<select>` 是受控的：直接把
 * `currentLocale()` 当 value，用户选完到语料到位之间会先弹回原值再跳过去，看起来像没选中。
 * 这里把在途的目标语言记下来顶上，落地后再交还给 `currentLocale()`。
 */
export function useLocalePicker(): LocalePicker {
  // 订阅 languageChanged：切换完成后要重渲染，才能拿到新的 currentLocale() 与译文。
  useTranslation()
  const [pending, setPending] = useState<AppLocale | null>(null)
  const change = useCallback((next: AppLocale) => {
    setPending(next)
    void setLocale(next).finally(() => setPending(null))
  }, [])
  return { locale: pending ?? currentLocale(), change }
}
