import { useTranslation } from '../i18n'
import { useTheme } from '../theme/useTheme'
import { MoonIcon, SunIcon } from './icons'

/** 登录页上的日月按钮：没有头像菜单的地方用它。图标是当前生效的那一套，点一下翻到另一套并固定。 */
export default function ThemeToggleButton({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  const { theme, toggle } = useTheme()
  const Icon = theme === 'dark' ? MoonIcon : SunIcon
  const label = t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark')
  return (
    <button
      type="button"
      data-display-setting="theme"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={className}
    >
      <Icon aria-hidden="true" />
    </button>
  )
}
