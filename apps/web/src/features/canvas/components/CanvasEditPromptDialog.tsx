import { useState } from 'react'
import { LABEL, PANEL_SECTION, PANEL_TITLE } from '../../../components/panelStyles'
import Overlay from '../../../components/patterns/Overlay'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { Button } from '../../../components/ui/button'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import type { ImageEl } from '../lib/canvasDoc'
import { submitCanvasImageEdit } from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'
/**
 * 整图编辑：说一句要求，这一张就地改掉。没有涂抹区域——要只改一块用局部重绘。
 */
export default function CanvasEditPromptDialog({
  editor,
  image,
  onClose,
}: {
  editor: CanvasEditor
  image: ImageEl
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  const [prompt, setPrompt] = useState('')
  const settings = useStore((state) => state.settings)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: 1,
  })

  const submit = () => {
    void submitCanvasImageEdit(editor, image, prompt)
    onClose()
  }

  return (
    <Overlay onClose={onClose}>
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl ring-1 ring-hairline animate-modal-in">
        <h3 className={`${PANEL_TITLE} mb-1.5`}>{t('imageEdit.title')}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{t('imageEdit.hint')}</p>

        <div className={`${LABEL} mb-1.5`}>{t('imageEdit.promptLabel')}</div>
        <Textarea
          autoFocus
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && prompt.trim()) {
              event.preventDefault()
              submit()
            }
          }}
          rows={4}
          placeholder={t('imageEdit.placeholder')}
          aria-label={t('imageEdit.promptLabel')}
          className="resize-none"
        />

        <div className={`${PANEL_SECTION} mt-3`}>
          {guard.blocked && guard.disabledReason && (
            <p className="mb-1.5 text-label-sm text-destructive">{guard.disabledReason}</p>
          )}
          <SubmissionBillingAction
            blockedAction={guard.blockedAction}
            className="mb-1.5 text-label-sm"
          />
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={guard.blocked || prompt.trim().length === 0}
            title={guard.disabledReason}
            onClick={submit}
          >
            {t('imageEdit.submit')}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}
