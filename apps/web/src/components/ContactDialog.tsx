import { SUPPORT_CONTACT, SUPPORT_MAILTO } from '@image-playground/shared/support-contact'
import { useState } from 'react'
import { useTranslation } from '../i18n'
import Dialog from './patterns/Dialog'
import { Button } from './ui/button'

/** 账户菜单里的「联系我们」。只展示邮箱，地址从 support-contact 取。 */
export default function ContactDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('shell')
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_CONTACT.email)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
    window.setTimeout(() => setCopied('idle'), 1600)
  }
  const copyLabel =
    copied === 'done'
      ? t('header.contact.copied')
      : copied === 'failed'
        ? t('header.contact.copyFailed')
        : t('header.contact.copy')
  return (
    <Dialog onClose={onClose} tier="raised" title={t('header.contact.title')}>
      <div className="flex items-center gap-3 rounded-xl border border-border p-3 text-sm">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{t('header.contact.email')}</div>
          <div className="truncate text-muted-foreground">{SUPPORT_CONTACT.email}</div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void copyEmail()}>
          {copyLabel}
        </Button>
        <Button asChild size="sm">
          <a href={SUPPORT_MAILTO}>{t('header.contact.send')}</a>
        </Button>
      </div>
    </Dialog>
  )
}
