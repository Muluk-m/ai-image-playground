import { useState } from 'react'
import Overlay from '../../../components/Overlay'
import {
  FIELD,
  LABEL,
  PANEL_SECTION,
  PANEL_TITLE,
  PRIMARY_BUTTON,
} from '../../../components/panelStyles'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import type { ImageEl } from '../lib/canvasDoc'
import { submitCanvasImageEdit } from '../lib/canvasImageEdits'
import type { CanvasEditor } from '../lib/editor'

/** 一句话逐张改已选图片，结果各自覆盖源图；整批先按张数过门禁。 */
export default function CanvasBatchEditDialog({
  editor,
  images,
  onClose,
}: {
  editor: CanvasEditor
  images: readonly ImageEl[]
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const settings = useStore((state) => state.settings)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: images.length,
  })

  const submit = async () => {
    if (submitting || guard.blocked || !prompt.trim()) return
    setSubmitting(true)
    try {
      for (const image of images) {
        const current = editor.getElement(image.id)
        if (current?.type !== 'image' || current.video) continue
        if (!(await submitCanvasImageEdit(editor, current, prompt))) break
      }
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Overlay onClose={submitting ? () => {} : onClose} tier="raised">
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10">
        <h3 className={`${PANEL_TITLE} mb-3`}>{t('batch.editTitle', { count: images.length })}</h3>
        <div className={`${LABEL} mb-1.5`}>{t('imageEdit.promptLabel')}</div>
        <textarea
          autoFocus
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          rows={4}
          placeholder={t('imageEdit.placeholder')}
          aria-label={t('imageEdit.promptLabel')}
          className={`${FIELD} resize-none`}
        />
        <div className={`${PANEL_SECTION} mt-4`}>
          {guard.blocked && guard.disabledReason && (
            <p className="mb-1.5 text-[11px] text-destructive">{guard.disabledReason}</p>
          )}
          <SubmissionBillingAction
            blockedAction={guard.blockedAction}
            className="mb-1.5 text-[11px]"
          />
          <button
            type="button"
            disabled={guard.blocked || submitting || !prompt.trim()}
            onClick={() => void submit()}
            className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
          >
            {t('batch.editSubmit', { count: images.length })}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
