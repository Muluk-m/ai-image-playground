import { useSyncExternalStore } from 'react'
import {
  getTheme,
  getThemeChoice,
  setThemeChoice,
  subscribeTheme,
  type Theme,
  type ThemeChoice,
  toggleTheme,
} from './index'

export interface ThemeControls {
  /** 此刻生效的那一套；跟随系统时就是系统的明暗。 */
  theme: Theme
  /** 用户的选择。`system` 表示没选过或选回了跟随系统。 */
  choice: ThemeChoice
  setChoice: (next: ThemeChoice) => void
  /** 固定为当前看到的相反一套。 */
  toggle: () => void
}

/** 头像菜单、登录页与设置面板三处主题控件共用。 */
export function useTheme(): ThemeControls {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'light' as const)
  const choice = useSyncExternalStore(subscribeTheme, getThemeChoice, () => 'system' as const)
  return { theme, choice, setChoice: setThemeChoice, toggle: toggleTheme }
}
