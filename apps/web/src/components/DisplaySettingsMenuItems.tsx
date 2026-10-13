import { openPricingSheet } from '../features/pricing/pricingSheetState'
import { useTranslation } from '../i18n'
import DisplaySettingsFields from './DisplaySettingsFields'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

interface DisplaySettingsMenuItemsProps {
  /** 两个头像菜单（公开树与私有 overlay）的行样式不同，由宿主菜单给。 */
  itemClassName: string
  iconClassName: string
}

/**
 * 头像菜单里的显示设置，以及套餐入口。
 * 收费版的账户菜单不在公开树里，但它已经渲染这一块，所以「套餐与定价」会落在
 * 套餐卡片下面，不必改私有 overlay。语言下拉仍留在这里。
 */
export default function DisplaySettingsMenuItems({
  itemClassName,
  iconClassName,
}: DisplaySettingsMenuItemsProps) {
  const { t } = useTranslation('shell')
  return (
    <>
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
      <DisplaySettingsFields rowClassName={itemClassName} iconClassName={iconClassName} />
      <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground">
        <a href="/terms" target="_blank" rel="noopener" className="hover:text-foreground">
          {t('nav.terms')}
        </a>
        <a href="/privacy" target="_blank" rel="noopener" className="hover:text-foreground">
          {t('nav.privacy')}
        </a>
      </div>
    </>
  )
}
