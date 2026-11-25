import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import Dialog from '../../../components/patterns/Dialog'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
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
  onSave: (name: string) => void | Promise<void>
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
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)
  const savingRef = useRef(false)
  const formId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mountedRef.current = true
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      mountedRef.current = false
    }
  }, [])

  const finalName = name.trim() || defaultName.trim()

  const handleSubmit = async () => {
    if (!finalName || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      await onSave(finalName)
    } catch {
      // Callers handle and toast their own failures; keep dialog unlocked so the user can retry.
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
  }

  const handleClose = () => {
    if (savingRef.current) return
    onCancel()
  }

  return (
    <Dialog
      onClose={handleClose}
      tier="raised"
      title={title}
      className="max-w-sm"
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={handleClose}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={!finalName || saving}>
            {saving && <Icon name="loading" size="xs" className="animate-spin" />}
            {t('action.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          void handleSubmit()
        }}
      >
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
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) {
                e.preventDefault()
              }
            }}
            placeholder={placeholder}
            maxLength={40}
            className="min-w-0 flex-1 rounded-xl"
          />
        </div>
      </form>
    </Dialog>
  )
}
