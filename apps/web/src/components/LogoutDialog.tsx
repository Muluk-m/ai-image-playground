import { useState } from 'react'
import { useTranslation } from '../i18n'
import { Checkbox } from './Checkbox'
import Overlay from './Overlay'

interface LogoutDialogProps {
  onCancel: () => void
  onConfirm: (clearLocalData: boolean) => void
}

/** 退出登录的确认框。勾选后连同当前用户 scope 的本机缓存一起删掉。 */
export default function LogoutDialog({ onCancel, onConfirm }: LogoutDialogProps) {
  const { t } = useTranslation(['shell', 'common'])
  const [clearLocalData, setClearLocalData] = useState(false)

  return (
    <Overlay onClose={onCancel} tier="alert">
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/50 bg-card p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in border-border dark:ring-white/10">
        <h3 className="text-base font-semibold text-foreground">{t('logout.title')}</h3>

        <Checkbox
          checked={clearLocalData}
          onChange={setClearLocalData}
          label={t('logout.clearLocalData')}
          tone="danger"
          className="mt-4"
        />

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm text-muted-foreground transition hover:bg-muted"
          >
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(clearLocalData)}
            className={`rounded-xl px-4 py-2 text-sm font-medium shadow-sm transition ${
              clearLocalData
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {t('logout.confirm')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
