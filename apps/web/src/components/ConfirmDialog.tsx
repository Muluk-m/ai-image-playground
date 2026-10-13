import { useEffect, useState } from 'react'
import { useTranslation } from '../i18n'
import { useStore } from '../store'
import Overlay from './patterns/Overlay'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

function renderMessage(message: string) {
  // 强调段两种写法：中文用「」，英文用弯引号，同一条消息翻过去后还是会被加粗。
  return message.split(/(`[^`]+`|「[^」]+」|“[^”]+”)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={index} className="rounded bg-muted px-1 py-0.5 text-body-sm text-foreground">
          {part.slice(1, -1)}
        </code>
      )
    }

    if (
      (part.startsWith('「') && part.endsWith('」')) ||
      (part.startsWith('“') && part.endsWith('”'))
    ) {
      return (
        <strong key={index} className="font-semibold text-foreground">
          {part}
        </strong>
      )
    }

    return part
  })
}

export default function ConfirmDialog() {
  const { t } = useTranslation(['shell', 'common'])
  const confirmDialog = useStore((s) => s.confirmDialog)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [canConfirm, setCanConfirm] = useState(true)

  useEffect(() => {
    const delay = confirmDialog?.minConfirmDelayMs ?? 0
    if (!confirmDialog || delay <= 0) {
      setCanConfirm(true)
      return
    }

    setCanConfirm(false)
    const timer = window.setTimeout(() => setCanConfirm(true), delay)
    return () => window.clearTimeout(timer)
  }, [confirmDialog])

  const handleClose = () => {
    if (!canConfirm) return
    setConfirmDialog(null)
  }

  const handleCancel = () => {
    confirmDialog?.cancelAction?.()
    handleClose()
  }

  if (!confirmDialog) return null
  // 破坏性语气靠标题里的动词认出来。调用方传的是已翻译的标题，所以动词也取当前语言的那份。
  const isDestructive = [t('common:action.delete'), t('common:action.clear')].some((verb) =>
    confirmDialog.title.includes(verb),
  )
  const confirmTone = confirmDialog.tone ?? (isDestructive ? 'danger' : undefined)
  // 按钮文案跟着最终语气走，不再单独看标题：调用方显式传了 tone 时，标题里没有「删除」二字
  // 也应当给出「确认删除」。否则显式 tone 只改颜色不改文案，两者会对不上。
  const confirmText =
    confirmDialog.confirmText ??
    t(confirmTone === 'danger' ? 'confirm.deleteConfirm' : 'confirm.confirm')
  const cancelText = confirmDialog.cancelText ?? t('common:action.cancel')

  return (
    <Overlay onClose={handleClose} tier="alert" label={confirmDialog.title}>
      <div className="relative bg-card/90 backdrop-blur-xl border border-border rounded-3xl shadow-dialog max-h-[90dvh] overflow-y-auto max-w-sm w-full p-6 z-10 ring-1 ring-hairline animate-confirm-in">
        <h3 className="mb-2 flex items-center gap-2 text-xl font-semibold text-foreground">
          {confirmDialog.icon === 'info' && (
            <Icon name="info" size="md" className="shrink-0 text-primary" />
          )}
          {confirmDialog.icon === 'copy' && (
            <Icon name="copy" size="md" className="shrink-0 text-primary" />
          )}
          {confirmDialog.title}
        </h3>
        <p
          className={`text-sm text-muted-foreground mb-6 leading-relaxed whitespace-pre-line ${confirmDialog.messageAlign === 'center' ? 'text-center' : ''}`}
        >
          {renderMessage(confirmDialog.message)}
        </p>
        <div className="flex gap-2">
          {confirmDialog.showCancel !== false && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCancel}
              className="flex-1"
            >
              {cancelText}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={confirmTone === 'danger' ? 'destructive' : 'default'}
            onClick={() => {
              if (!canConfirm) return
              confirmDialog.action()
              setConfirmDialog(null)
            }}
            disabled={!canConfirm}
            className={`flex-1 ${confirmTone === 'warning' ? 'bg-warning text-warning-foreground hover:bg-warning/90' : ''}`}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}
