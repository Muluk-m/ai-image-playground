import { useState } from 'react'
import { useTranslation } from '../i18n'
import { Checkbox } from './patterns/Checkbox'
import Dialog from './patterns/Dialog'
import { Button } from './ui/button'

interface LogoutDialogProps {
  onCancel: () => void
  onConfirm: (clearLocalData: boolean) => void
}

/** 退出登录的确认框。勾选后连同当前用户 scope 的本机缓存一起删掉。 */
export default function LogoutDialog({ onCancel, onConfirm }: LogoutDialogProps) {
  const { t } = useTranslation(['shell', 'common'])
  const [clearLocalData, setClearLocalData] = useState(false)

  return (
    <Dialog
      title={t('logout.title')}
      onClose={onCancel}
      tier="alert"
      className="max-w-sm"
      footer={
        <>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t('common:action.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={clearLocalData ? 'destructive' : 'default'}
            onClick={() => onConfirm(clearLocalData)}
          >
            {t('logout.confirm')}
          </Button>
        </>
      }
    >
      <Checkbox
        checked={clearLocalData}
        onChange={setClearLocalData}
        label={t('logout.clearLocalData')}
        tone="danger"
      />
    </Dialog>
  )
}
