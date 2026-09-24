import { THEME_COLORS, THEME_STORAGE_KEY } from './bootScript'

export { THEME_STORAGE_KEY }

/**
 * 主题是显示设置：默认暗色，只有手动选择亮色才切换。
 * 只存本机，登录前就生效，不属于用户设置，不随账号同步；登录、退出都不清它。
 */
export type Theme = 'light' | 'dark'
export type ThemeChoice = Theme

/** 只有明确保存的亮色能覆盖暗色默认值；旧的 system 和无效存值也回到暗色。 */
export function resolveTheme(stored: string | null | undefined): Theme {
  return stored === 'light' ? 'light' : 'dark'
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    // Safari 隐私模式下读 localStorage 会抛，不该因此挡住启动。
    return null
  }
}

let choice: ThemeChoice = 'dark'
let theme: Theme = 'dark'
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
  theme = resolveTheme(choice)
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
    localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // 存不下也要让本次选择生效，只是刷新后回到暗色。
  }
  apply()
}

/**
 * 读出本机的选择。首帧的样子已经由内联脚本定好。
 */
export function initTheme(): void {
  choice = resolveTheme(readStored())
  apply()
}
