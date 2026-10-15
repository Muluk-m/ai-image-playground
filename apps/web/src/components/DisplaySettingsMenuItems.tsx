import { openPricingSheet } from '../features/pricing/pricingSheetState'
import { useTranslation } from '../i18n'
import DisplaySettingsFields from './DisplaySettingsFields'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

interface DisplaySettingsMenuItemsProps {
  /** 两个头像菜单（公开树与私有 overlay）的行样式不同，由宿主菜单给。 */
  itemClassName: string
  iconClassName: string
  /** 收费菜单自己有开通套餐入口时关掉，避免同一件事出现两次。 */
  showPlans?: boolean
  /** 语言只在顶栏地球。菜单默认不放这一行。 */
  showLanguage?: boolean
  /** 收费菜单自己画条款链接时关掉。 */
  showLegal?: boolean
}

/**
 * 头像菜单里的显示设置，以及可选的套餐入口和条款。
 * 收费版的账户菜单不在公开树里，它渲染这一块时关掉自己已经有的行，
 * 不要再用 CSS 把按钮或语言下拉藏起来。
 */
export default function DisplaySettingsMenuItems({
  itemClassName,
  iconClassName,
  showPlans = true,
  showLanguage = false,
  showLegal = true,
}: DisplaySettingsMenuItemsProps) {
  const { t } = useTranslation('shell')
  return (
    <>
      {showPlans ? (
        <Button
          type="button"
          role="menuitem"
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          onClick={() => openPricingSheet()}
        >
          <Icon name="membershipFree" className={iconClassName} />
          <span>{t('nav.plans')}</span>
        </Button>
      ) : null}
      <DisplaySettingsFields
        showLanguage={showLanguage}
        showTheme
        rowClassName={itemClassName}
        iconClassName={iconClassName}
      />
      {showLegal ? (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
          <a href="/terms" target="_blank" rel="noopener" className="hover:text-foreground">
            {t('nav.terms')}
          </a>
          <span aria-hidden="true">·</span>
          <a href="/privacy" target="_blank" rel="noopener" className="hover:text-foreground">
            {t('nav.privacy')}
          </a>
        </div>
      ) : null}
    </>
  )
}
