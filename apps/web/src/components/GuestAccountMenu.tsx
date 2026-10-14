import { GUIDE_PATHS } from '../features/guide/paths'
import { openPricingSheet } from '../features/pricing/pricingSheetState'
import { SUPPORTED_LOCALES, useTranslation } from '../i18n'
import { useLocalePicker } from '../i18n/useLocalePicker'
import { cn } from '../lib/utils'
import type { ThemeChoice } from '../theme'
import { THEME_LABEL_KEY } from '../theme/labels'
import { useTheme } from '../theme/useTheme'
import { Button } from './ui/button'
import { Icon, type IconName } from './ui/icon'

const THEME_CHOICES: readonly ThemeChoice[] = ['dark', 'light']

/**
 * 未登录时点灰色人形打开的面板。语言和主题在这里改，设置入口不靠登录。
 * 登录后的芽标菜单不走这里。
 */
export default function GuestAccountMenu({
  authEnabled,
  onLogin,
  onClose,
}: {
  authEnabled: boolean
  onLogin: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('shell')
  const { t: tCommon } = useTranslation('common')
  const { locale, change } = useLocalePicker()
  const { theme, setChoice } = useTheme()

  return (
    <div
      role="menu"
      aria-label={t('header.appMenu')}
      className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-3 text-sm shadow-popover"
    >
      <div className="flex items-center gap-2.5 px-1 pb-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon name="user" className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-foreground">{t('header.guest.signedOut')}</span>
          <span className="block text-xs text-muted-foreground">{t('header.guest.syncHint')}</span>
        </span>
      </div>
      {authEnabled ? (
        <div className="rounded-xl border border-primary/30 bg-primary/10 p-3">
          <div className="flex items-center gap-1.5 font-medium text-primary">
            <Icon name="generate" />
            <span>{t('header.guest.trialTitle')}</span>
          </div>
          <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
            {t('header.guest.trialBody')}
          </p>
          <Button type="button" className="mt-3 w-full" onClick={onLogin}>
            {t('header.guest.signInUp')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col pt-2">
        <MenuRow
          icon="membershipFree"
          label={t('nav.plans')}
          trailing={t('header.guest.viewPlans')}
          onClick={() => {
            onClose()
            openPricingSheet()
          }}
        />
        <MenuLink
          icon="help"
          label={t('header.guest.help')}
          href={`${GUIDE_PATHS[locale]}#faq`}
          onClick={onClose}
        />
        <MenuLink
          icon="guide"
          label={t('nav.guide')}
          href={GUIDE_PATHS[locale]}
          onClick={onClose}
        />
      </div>
      <div className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
        <Segment
          label={tCommon('locale.label')}
          icon="language"
          value={locale}
          options={SUPPORTED_LOCALES.map((code) => ({
            value: code,
            label: tCommon(`locale.${code}` as const),
            lang: code,
          }))}
          onChange={(next) => change(next)}
        />
        <Segment
          label={tCommon('theme.label')}
          icon={theme === 'dark' ? 'dark' : 'light'}
          value={theme}
          options={THEME_CHOICES.map((choice) => ({
            value: choice,
            label: tCommon(THEME_LABEL_KEY[choice]),
          }))}
          onChange={setChoice}
        />
      </div>
      <div className="flex items-center gap-2 px-2 pt-2 text-xs text-muted-foreground">
        <a href="/terms" target="_blank" rel="noopener" className="hover:text-foreground">
          {t('nav.terms')}
        </a>
        <span aria-hidden="true">·</span>
        <a href="/privacy" target="_blank" rel="noopener" className="hover:text-foreground">
          {t('nav.privacy')}
        </a>
      </div>
    </div>
  )
}

function MenuRow({
  icon,
  label,
  trailing,
  onClick,
}: {
  icon: IconName
  label: string
  trailing?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left hover:bg-muted"
    >
      <Icon name={icon} className="text-muted-foreground" />
      <span className="flex-1">{label}</span>
      {trailing ? <span className="text-xs text-muted-foreground">{trailing}</span> : null}
      <Icon name="chevronRight" className="text-muted-foreground" />
    </button>
  )
}

function MenuLink({
  icon,
  label,
  href,
  onClick,
}: {
  icon: IconName
  label: string
  href: string
  onClick: () => void
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 hover:bg-muted"
    >
      <Icon name={icon} className="text-muted-foreground" />
      <span className="flex-1">{label}</span>
      <Icon name="chevronRight" className="text-muted-foreground" />
    </a>
  )
}

function Segment<T extends string>({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string
  icon: IconName
  value: T
  options: readonly { value: T; label: string; lang?: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5">
      <span className="flex items-center gap-2.5">
        <Icon name={icon} className="text-muted-foreground" />
        <span>{label}</span>
      </span>
      <div role="group" aria-label={label} className="flex rounded-lg bg-muted p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            lang={option.lang}
            aria-pressed={value === option.value}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs',
              value === option.value
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
