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
      <button
        type="button"
        onClick={onRelogin}
        className="shrink-0 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('expired.relogin')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('expired.dismiss')}
        className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          className="h-4 w-4"
          aria-hidden
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  )
}
