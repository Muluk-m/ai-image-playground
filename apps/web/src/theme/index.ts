import { THEME_COLORS, THEME_STORAGE_KEY } from './bootScript'

export { THEME_STORAGE_KEY }

/**
 * 主题是显示设置：默认暗色。手动选亮色或暗色就固定；选「跟随系统」才读
 * `prefers-color-scheme`，并且系统一变就跟着变。
 * 只存本机，登录前就生效，不属于用户设置，不随账号同步；登录、退出都不清它。
 * 样式只认 `<html class="dark">`，不要在 CSS 里写 `@media (prefers-color-scheme)`。
 */
export type Theme = 'light' | 'dark'
export type ThemeChoice = Theme | 'system'

const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

/** 已保存的选择。只有 light / dark / system 有效，其余回到暗色。 */
export function resolveThemeChoice(stored: string | null | undefined): ThemeChoice {
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  return 'dark'
}

/**
 * 把选择落到此刻的明暗。`systemDark` 是系统是否偏暗；非 system 选择不看它。
 * 首帧脚本是同一条规则的另一份实现。
 */
export function resolveTheme(stored: string | null | undefined, systemDark = true): Theme {
  const choice = resolveThemeChoice(stored)
  if (choice === 'system') return systemDark ? 'dark' : 'light'
  return choice
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    // Safari 隐私模式下读 localStorage 会抛，不该因此挡住启动。
    return null
  }
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  try {
    return window.matchMedia(SYSTEM_QUERY).matches
  } catch {
    return true
  }
}

let choice: ThemeChoice = 'dark'
let theme: Theme = 'dark'
const listeners = new Set<() => void>()
let systemQuery: MediaQueryList | null = null
let onSystemChange: ((event: MediaQueryListEvent) => void) | null = null

function detachSystemListener(): void {
  if (systemQuery && onSystemChange) systemQuery.removeEventListener('change', onSystemChange)
  systemQuery = null
  onSystemChange = null
}

/** 只有「跟随系统」才订阅。切走之后系统再变，不再改这台设备的主题。 */
function syncSystemListener(): void {
  detachSystemListener()
  if (choice !== 'system') return
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  try {
    systemQuery = window.matchMedia(SYSTEM_QUERY)
  } catch {
    return
  }
  onSystemChange = () => apply()
  systemQuery.addEventListener('change', onSystemChange)
}

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
  theme = resolveTheme(choice, choice === 'system' ? readSystemDark() : true)
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
  syncSystemListener()
  apply()
}

/**
 * 读出本机的选择。首帧的样子已经由内联脚本定好。
 */
export function initTheme(): void {
  choice = resolveThemeChoice(readStored())
  syncSystemListener()
  apply()
}
