import { useEffect, useState } from 'react'
import { useTranslation } from '../i18n'
import { useStore } from '../store'
import { CopyIcon } from './icons'
import Overlay from './Overlay'

function renderMessage(message: string) {
  // 强调段两种写法：中文用「」，英文用弯引号，同一条消息翻过去后还是会被加粗。
  return message.split(/(`[^`]+`|「[^」]+」|“[^”]+”)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={index}
          className="rounded bg-gray-100 px-1 py-0.5 text-[0.85em] text-gray-700 dark:bg-white/[0.06] dark:text-gray-200"
        >
          {part.slice(1, -1)}
        </code>
      )
    }

    if (
      (part.startsWith('「') && part.endsWith('」')) ||
      (part.startsWith('“') && part.endsWith('”'))
    ) {
      return (
        <strong key={index} className="font-semibold text-gray-700 dark:text-gray-200">
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
  const confirmClassName =
    confirmTone === 'warning'
      ? 'bg-orange-500 hover:bg-orange-600'
      : confirmTone === 'danger'
        ? 'bg-red-500 hover:bg-red-600'
        : 'bg-blue-500 hover:bg-blue-600'
  const confirmText =
    confirmDialog.confirmText ?? t(isDestructive ? 'confirm.deleteConfirm' : 'confirm.confirm')
  const cancelText = confirmDialog.cancelText ?? t('common:action.cancel')

  return (
    <Overlay onClose={handleClose} tier="alert">
      <div className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-sm w-full p-6 z-10 ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in">
        <h3 className="mb-2 flex items-center gap-2 text-base font-bold text-gray-800 dark:text-gray-100">
          {confirmDialog.icon === 'info' && (
            <svg
              className="h-5 w-5 shrink-0 text-blue-500"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
          )}
          {confirmDialog.icon === 'copy' && <CopyIcon className="h-5 w-5 shrink-0 text-blue-500" />}
          {confirmDialog.title}
        </h3>
        <p
          className={`text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed whitespace-pre-line ${confirmDialog.messageAlign === 'center' ? 'text-center' : ''}`}
        >
          {renderMessage(confirmDialog.message)}
        </p>
        <div className="flex gap-2">
          {confirmDialog.showCancel !== false && (
            <button
              onClick={handleCancel}
              className="flex-1 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06] transition"
            >
              {cancelText}
            </button>
          )}
          <button
            onClick={() => {
              if (!canConfirm) return
              confirmDialog.action()
              setConfirmDialog(null)
            }}
            disabled={!canConfirm}
            className={`flex-1 py-2 rounded-lg text-white text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${confirmClassName}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
