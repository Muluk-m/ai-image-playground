import { type ReactNode, useEffect, useRef, useState } from 'react'
import Overlay from '../../../components/Overlay'

interface NamingDialogProps {
  title: string
  /** 标题下的一行说明；省略则不占位 */
  description?: ReactNode
  placeholder: string
  /** 空名时回落到它；也用作输入框的初值 */
  defaultName?: string
  /** 输入框左侧的缩略图 */
  preview?: ReactNode
  onCancel: () => void
  onSave: (name: string) => void
}

/** 存素材 / 存模板共用的取名对话框；空名一律不保存。 */
export default function NamingDialog({
  title,
  description,
  placeholder,
  defaultName = '',
  preview,
  onCancel,
  onSave,
}: NamingDialogProps) {
  const [name, setName] = useState(defaultName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const finalName = name.trim() || defaultName.trim()

  return (
    <Overlay onClose={onCancel} tier="raised">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (finalName) onSave(finalName)
        }}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/50 bg-white p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10"
      >
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
        {description && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{description}</p>
        )}

        <div className="mt-4 flex items-center gap-3">
          {preview && (
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
              {preview}
            </div>
          )}
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            maxLength={40}
            className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100 dark:focus:border-blue-500/50 dark:focus:ring-blue-500/15"
          />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!finalName}
            className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 dark:disabled:bg-white/10 dark:disabled:text-gray-500"
          >
            保存
          </button>
        </div>
      </form>
    </Overlay>
  )
}
