import { THEME_COLORS, THEME_STORAGE_KEY } from './bootScript'

export { THEME_STORAGE_KEY }

/**
 * 主题是显示设置：没选过时跟随系统明暗，选了就固定在这台设备上。
 * 只存本机，登录前就生效，不属于用户设置，不随账号同步；登录、退出都不清它。
 */
export type Theme = 'light' | 'dark'
export type ThemeChoice = Theme | 'system'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/** 已保存的选择加上系统是否偏暗，得到此刻该用哪一套。认不出的存值一律当没选过。 */
export function resolveTheme(stored: string | null | undefined, systemDark: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored
  return systemDark ? 'dark' : 'light'
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    // Safari 隐私模式下读 localStorage 会抛，不该因此挡住启动。
    return null
  }
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(SYSTEM_DARK_QUERY).matches
}

let choice: ThemeChoice = 'system'
let theme: Theme = 'light'
const listeners = new Set<() => void>()

/** 正常由首帧脚本建好；测试环境或脚本被拦掉时这里补一个。 */
function themeColorMeta(): HTMLMetaElement {
  const existing = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (existing) return existing
  const created = document.createElement('meta')
  created.name = 'theme-color'
  document.head.appendChild(created)
  return created
}

function apply(): void {
  theme = resolveTheme(choice, systemDark())
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    themeColorMeta().setAttribute('content', THEME_COLORS[theme])
  }
  for (const listener of listeners) listener()
}

export function getThemeChoice(): ThemeChoice {
  return choice
}

export function getTheme(): Theme {
  return theme
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setThemeChoice(next: ThemeChoice): void {
  choice = next
  try {
    if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // 存不下也要让本次选择生效，只是刷新后回到跟随系统。
  }
  apply()
}

/** 一键翻转：固定为当前看到的相反一套。 */
export function toggleTheme(): void {
  setThemeChoice(theme === 'dark' ? 'light' : 'dark')
}

/**
 * 读出本机的选择并开始盯系统明暗。首帧的样子已经由内联脚本定好，这里接手之后的变化。
 * 返回的函数停止监听，只有测试需要。
 */
export function initTheme(): () => void {
  const stored = readStored()
  choice = stored === 'light' || stored === 'dark' ? stored : 'system'
  apply()
  const media = typeof window === 'undefined' ? undefined : window.matchMedia?.(SYSTEM_DARK_QUERY)
  // 固定了主题时 resolveTheme 不看系统，所以这里不必区分，重算一次即可。
  const onSystemChange = (): void => apply()
  media?.addEventListener('change', onSystemChange)
  return () => media?.removeEventListener('change', onSystemChange)
}
