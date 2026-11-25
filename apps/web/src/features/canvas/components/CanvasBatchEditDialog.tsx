import { useRef, useState } from 'react'
import { LABEL, PANEL_SECTION, PANEL_TITLE } from '../../../components/panelStyles'
import Overlay from '../../../components/patterns/Overlay'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Textarea } from '../../../components/ui/textarea'
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
  const { t } = useTranslation(['canvas', 'common'])
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submittedIds, setSubmittedIds] = useState<ReadonlySet<string>>(() => new Set())
  const submittedIdsRef = useRef<Set<string>>(new Set())
  const submittingRef = useRef(false)
  const remainingImages = images.filter((image) => !submittedIds.has(image.id))
  const settings = useStore((state) => state.settings)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: remainingImages.length,
  })

  const requestClose = () => {
    if (submittingRef.current || submitting) return
    if (prompt.trim() && submittedIdsRef.current.size === 0) {
      useStore.getState().setConfirmDialog({
        title: t('pixelEdit.discardTitle'),
        message: t('pixelEdit.discardMessage'),
        confirmText: t('pixelEdit.discardConfirm'),
        tone: 'danger',
        action: onClose,
      })
      return
    }
    onClose()
  }

  const submit = async () => {
    if (
      submittingRef.current ||
      submitting ||
      guard.blocked ||
      !prompt.trim() ||
      remainingImages.length === 0
    )
      return
    submittingRef.current = true
    setSubmitting(true)
    try {
      let failed = false
      for (const image of images) {
        if (submittedIdsRef.current.has(image.id)) continue
        const current = editor.getElement(image.id)
        if (current?.type !== 'image' || current.video) continue
        if (!(await submitCanvasImageEdit(editor, current, prompt))) {
          failed = true
          break
        }
        submittedIdsRef.current.add(image.id)
        setSubmittedIds(new Set(submittedIdsRef.current))
      }
      if (!failed) onClose()
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <Overlay onClose={submitting ? () => {} : requestClose} tier="raised">
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl ring-1 ring-hairline animate-modal-in">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className={PANEL_TITLE}>{t('batch.editTitle', { count: images.length })}</h3>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            autoTooltip={false}
            disabled={submitting}
            onClick={requestClose}
            aria-label={t('common:action.close')}
            className="text-muted-foreground hover:text-foreground"
          >
            <Icon name="close" />
          </Button>
        </div>
        <div className={`${LABEL} mb-1.5`}>{t('imageEdit.promptLabel')}</div>
        <Textarea
          autoFocus
          disabled={submitting}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          rows={4}
          placeholder={t('imageEdit.placeholder')}
          aria-label={t('imageEdit.promptLabel')}
          className="resize-none"
        />
        <div className={`${PANEL_SECTION} mt-4`}>
          {guard.blocked && guard.disabledReason && (
            <p className="mb-1.5 text-label-sm text-destructive">{guard.disabledReason}</p>
          )}
          <SubmissionBillingAction
            blockedAction={guard.blockedAction}
            className="mb-1.5 text-label-sm"
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={requestClose}
            >
              {t('common:action.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1"
              aria-busy={submitting || undefined}
              disabled={
                guard.blocked || submitting || !prompt.trim() || remainingImages.length === 0
              }
              onClick={() => void submit()}
            >
              {submitting && <Icon name="loading" className="animate-spin" />}
              {t('batch.editSubmit', { count: remainingImages.length })}
            </Button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
