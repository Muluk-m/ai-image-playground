import { Button } from '../components/ui/button'
import { Icon } from '../components/ui/icon'
import { useTranslation } from '../i18n'

interface SessionExpiredCardProps {
  onRelogin: () => void
  onDismiss: () => void
}

/**
 * 会话在使用中过期时的提示。刻意不是模态：工作台还在，未保存的草稿、正在看的图都不该被顶掉，
 * 用户可以先收尾再回来登录。地址栏不动，登录成功后整页 reload 回到同一处。
 */
export function SessionExpiredCard({ onRelogin, onDismiss }: SessionExpiredCardProps) {
  const { t } = useTranslation('auth')
  return (
    <div
      role="status"
      className="animate-modal-in fixed bottom-4 right-4 z-[90] flex w-[min(420px,calc(100vw-2rem))] items-center gap-3 rounded-2xl border border-border bg-card/95 p-4 shadow-xl backdrop-blur"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{t('expired.title')}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t('expired.description')}
        </p>
      </div>
      <Button type="button" onClick={onRelogin} size="sm" className="shrink-0">
        {t('expired.relogin')}
      </Button>
      <Button
        type="button"
        onClick={onDismiss}
        aria-label={t('expired.dismiss')}
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground"
      >
        <Icon name="close" />
      </Button>
    </div>
  )
}
