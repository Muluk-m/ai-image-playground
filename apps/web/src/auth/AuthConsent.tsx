import { Button } from '../components/ui/button'
import { openPricingSheet } from '../features/pricing/pricingSheetState'
import { useTranslation } from '../i18n'

/**
 * 登录框底部：套餐入口，以及服务条款 / 隐私政策。
 * 条款在新标签打开，避免把正在填写的登录框整页换掉。
 */
export default function AuthConsent({ kind }: { kind: 'login' | 'registration' }) {
  const { t } = useTranslation('auth')
  const lead = kind === 'login' ? t('consent.loginLead') : t('consent.registerLead')
  const joiner = kind === 'login' ? t('consent.loginJoiner') : t('consent.registerJoiner')
  return (
    <div className="mt-4 text-center">
      <Button type="button" variant="link" size="xs" onClick={() => openPricingSheet()}>
        {t('consent.viewPlans')}
      </Button>
      <p className="auth-terms">
        {lead}
        <a
          href="/terms"
          target="_blank"
          rel="noopener"
          className="underline underline-offset-2 hover:text-foreground"
        >
          {t('consent.termsName')}
        </a>
        {joiner}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener"
          className="underline underline-offset-2 hover:text-foreground"
        >
          {t('consent.privacyName')}
        </a>
      </p>
    </div>
  )
}
