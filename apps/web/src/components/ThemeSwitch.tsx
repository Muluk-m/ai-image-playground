import { useTranslation } from '../i18n'
import { cn } from '../lib/utils'
import type { ThemeChoice } from '../theme'
import { THEME_LABEL_KEY } from '../theme/labels'
import { useTheme } from '../theme/useTheme'
import { Button } from './ui/button'
import { Icon, type IconName } from './ui/icon'

/** 暗色、跟随系统、亮色。两个头像菜单用同一份，顺序不要调。 */
const SEGMENTS: readonly { choice: ThemeChoice; icon: IconName }[] = [
  { choice: 'dark', icon: 'dark' },
  { choice: 'system', icon: 'system' },
  { choice: 'light', icon: 'light' },
]

/**
 * 只放图标的三段主题开关。当前这一段高亮。
 * 访客菜单和登录后的菜单都渲染这一份，不要再各写一个下拉。
 */
export default function ThemeSwitch({ className }: { className?: string }) {
  const { t } = useTranslation('common')
  const { choice, setChoice } = useTheme()

  return (
    <div
      role="group"
      aria-label={t('theme.label')}
      className={cn('flex rounded-full bg-muted p-0.5', className)}
    >
      {SEGMENTS.map((segment) => {
        const active = choice === segment.choice
        return (
          <Button
            key={segment.choice}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t(THEME_LABEL_KEY[segment.choice])}
            aria-pressed={active}
            className={cn(
              'rounded-full',
              active
                ? 'bg-card text-foreground shadow-sm hover:bg-card'
                : 'text-muted-foreground hover:bg-transparent',
            )}
            onClick={() => setChoice(segment.choice)}
          >
            <Icon name={segment.icon} />
          </Button>
        )
      })}
    </div>
  )
}
