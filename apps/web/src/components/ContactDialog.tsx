import {
  SUPPORT_CONTACT,
  SUPPORT_MAILTO,
  SUPPORT_X_URL,
} from '@image-playground/shared/support-contact'
import { useState } from 'react'
import { useTranslation } from '../i18n'
import Dialog from './patterns/Dialog'
import { Button } from './ui/button'

/** 账户菜单里的「联系我们」。渠道只从 support-contact 取，和落地页联系弹窗同一套。 */
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
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-3 rounded-xl border border-border p-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">X</div>
            <div className="truncate text-muted-foreground">@{SUPPORT_CONTACT.xHandle}</div>
          </div>
          <Button asChild size="sm">
            <a href={SUPPORT_X_URL} target="_blank" rel="noopener noreferrer">
              {t('header.contact.message')}
            </a>
          </Button>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border p-3">
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
      </div>
    </Dialog>
  )
}
