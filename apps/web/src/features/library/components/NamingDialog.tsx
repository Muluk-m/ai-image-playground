import { type ReactNode, useEffect, useRef, useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'

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
  const { t } = useTranslation()
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
        className="relative z-10 w-full max-w-sm rounded-2xl border bg-card p-5 shadow-2xl ring-1 ring-hairline animate-modal-in border-border"
      >
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}

        <div className="mt-4 flex items-center gap-3">
          {preview && (
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-border">
              {preview}
            </div>
          )}
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            maxLength={40}
            className="min-w-0 flex-1 rounded-xl"
          />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!finalName}>
            {t('action.save')}
          </Button>
        </div>
      </form>
    </Overlay>
  )
}
