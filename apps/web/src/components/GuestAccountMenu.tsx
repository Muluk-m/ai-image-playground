import { GUIDE_PATHS } from '../features/guide/paths'
import { openPricingSheet } from '../features/pricing/pricingSheetState'
import { useTranslation } from '../i18n'
import { useLocalePicker } from '../i18n/useLocalePicker'
import DisplaySettingsFields from './DisplaySettingsFields'
import { Button } from './ui/button'
import { Icon, type IconName } from './ui/icon'

/**
 * 未登录时点灰色人形打开的面板。主题在这里改，语言只在顶栏地球。
 * 帮助与使用指南合成一行，进指南页（常见问题在那一页里）。
 * 设置直接打开应用设置。登录后的芽标菜单不走这里，但主题开关和页脚是同一套。
 */
export default function GuestAccountMenu({
  authEnabled,
  onLogin,
  onClose,
  onOpenSettings,
}: {
  authEnabled: boolean
  onLogin: () => void
  onClose: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('shell')
  const { locale } = useLocalePicker()

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
          href={GUIDE_PATHS[locale]}
          onClick={onClose}
        />
      </div>
      <div className="mt-1 flex flex-col border-t border-border pt-2">
        <DisplaySettingsFields
          showLanguage={false}
          showTheme
          rowClassName="px-2"
          iconClassName="size-4"
        />
        <MenuRow icon="settings" label={t('header.settings')} onClick={onOpenSettings} />
      </div>
      <div className="mt-1 flex items-center gap-1.5 border-t border-border px-2 pt-3 text-xs text-muted-foreground">
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
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className="h-11 w-full justify-start gap-3 px-2 font-normal text-foreground"
    >
      <Icon name={icon} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ? <span className="text-xs text-muted-foreground">{trailing}</span> : null}
      <Icon name="chevronRight" className="text-muted-foreground" />
    </Button>
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
      className="flex h-11 w-full items-center gap-3 rounded-lg px-2 text-foreground hover:bg-muted"
    >
      <Icon name={icon} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Icon name="chevronRight" className="text-muted-foreground" />
    </a>
  )
}
