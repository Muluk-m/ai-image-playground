import Overlay from '../../components/patterns/Overlay'
import { useTranslation } from '../../i18n'
import PricingPage from './PricingPage'
import { closePricingSheet, usePricingSheetOpen } from './pricingSheet'

/** 复用 `/pricing` 的正文，装进工作台里的一层弹层。 */
export default function PricingSheet() {
  const open = usePricingSheetOpen()
  const { t } = useTranslation('pricing')
  if (!open) return null
  return (
    <Overlay
      onClose={closePricingSheet}
      tier="alert"
      layout="fill"
      role="none"
      label={t('nav.pricing')}
    >
      <div className="flex h-dvh w-full bg-black/50 sm:p-3 md:p-6">
        <div className="pricing-surface relative mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col overflow-hidden sm:rounded-3xl sm:ring-1 sm:ring-white/10">
          <PricingPage presentation="sheet" />
        </div>
      </div>
    </Overlay>
  )
}
