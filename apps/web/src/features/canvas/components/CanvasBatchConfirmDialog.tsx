import { useState } from 'react'
import Credits from '../../../components/Credits'
import Overlay from '../../../components/Overlay'
import { OUTLINE_BUTTON, PANEL_TITLE, PRIMARY_BUTTON } from '../../../components/panelStyles'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'

/**
 * 批量 AI 动作发出前的确认：一次点击会按张数各发一个生成任务并扣费，
 * 不能让比例选择这类看起来像本地预览的操作直接提交。
 */
export default function CanvasBatchConfirmDialog({
  title,
  note,
  count,
  onConfirm,
  onClose,
}: {
  title: string
  note: string
  count: number
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  const [submitting, setSubmitting] = useState(false)
  const settings = useStore((state) => state.settings)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: count,
  })

  const confirm = async () => {
    if (submitting || guard.blocked) return
    setSubmitting(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Overlay onClose={submitting ? () => {} : onClose} tier="raised">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-card p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10"
        // 画布在 window 上听快捷键：Delete / ⌘A / 切工具都会改掉这批选区，弹窗开着时一律拦下。
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !submitting) onClose()
        }}
      >
        <h3 className={`${PANEL_TITLE} mb-2`}>{title}</h3>
        <p className="text-xs text-muted-foreground">{t('batch.confirmBody', { count })}</p>
        <p className="mt-1 text-xs text-muted-foreground">{note}</p>
        {guard.estimatedCredits !== undefined && (
          <p className="mt-2 flex items-center gap-1 text-xs text-foreground">
            {t('batch.confirmCost')}
            <Credits credits={guard.estimatedCredits} />
          </p>
        )}
        {guard.blocked && guard.disabledReason && (
          <p className="mt-2 text-label-sm text-destructive">{guard.disabledReason}</p>
        )}
        <SubmissionBillingAction
          blockedAction={guard.blockedAction}
          className="mt-2 text-label-sm"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            disabled={submitting}
            onClick={onClose}
            className={`${OUTLINE_BUTTON} disabled:cursor-not-allowed`}
          >
            {t('batch.confirmCancel')}
          </button>
          <button
            type="button"
            disabled={guard.blocked || submitting}
            onClick={() => void confirm()}
            className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
          >
            {t('batch.confirmSubmit', { count })}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
