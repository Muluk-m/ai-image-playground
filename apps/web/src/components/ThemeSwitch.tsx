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

  const activeIndex = Math.max(
    0,
    SEGMENTS.findIndex((segment) => segment.choice === choice),
  )

  return (
    <div
      role="group"
      aria-label={t('theme.label')}
      className={cn('relative grid grid-cols-3 rounded-full bg-muted p-0.5', className)}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0.5 left-0.5 z-0 rounded-full bg-card shadow-sm transition-transform duration-normal ease-motion-in-out motion-reduce:transition-none"
        style={{
          width: 'calc((100% - 4px) / 3)',
          transform: `translate3d(${activeIndex * 100}%, 0, 0)`,
        }}
      />
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
              'relative z-[1] rounded-full hover:bg-transparent',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
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
