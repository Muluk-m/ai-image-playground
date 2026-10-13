import { type VideoDeriveMode, videoRateMultiplier } from '@image-playground/shared'
import { useState } from 'react'
import Credits from '../../../components/Credits'
import { SettingsChoice } from '../../../components/composer/SettingsPanel'
import { LABEL, PANEL_SECTION } from '../../../components/panelStyles'
import Dialog from '../../../components/patterns/Dialog'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { Button } from '../../../components/ui/button'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { DEFAULT_EXTEND_SECONDS, DERIVE_RESOLUTION, VIDEO_EXTEND_SECONDS } from '../lib/derive'
import { videoDeriveLabel } from '../lib/labels'

/** 续写 / 改视频弹窗：谁的源片、提交到哪由调用方给。 */
export default function DeriveVideoPopover({
  sourceSeconds,
  mode,
  modelId,
  tier = 'raised',
  initialPrompt = '',
  initialSeconds,
  onSubmit,
  onClose,
}: {
  /** 源片时长。改视频保持它；续写另选秒数。 */
  sourceSeconds: number
  mode: VideoDeriveMode
  modelId: string
  tier?: 'raised' | 'alert'
  /** 「重新生成」一段派生片时，预填它当时的描述与续写秒数。 */
  initialPrompt?: string
  initialSeconds?: number
  /** 受理了返回 true，弹窗随即关闭并提示已提交。 */
  onSubmit: (input: { mode: VideoDeriveMode; prompt: string; seconds: number }) => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useTranslation('video')
  const [prompt, setPrompt] = useState(initialPrompt)
  const [extendSeconds, setExtendSeconds] = useState<number>(
    initialSeconds !== undefined &&
      (VIDEO_EXTEND_SECONDS as readonly number[]).includes(initialSeconds)
      ? initialSeconds
      : DEFAULT_EXTEND_SECONDS,
  )
  const seconds = mode === 'edit' ? sourceSeconds : extendSeconds
  const label = videoDeriveLabel(mode)
  const title = mode === 'extend' ? t('derive.titleExtend') : t('derive.titleEdit')
  const placeholder =
    mode === 'extend' ? t('derive.placeholderExtend') : t('derive.placeholderEdit')

  const guard = usePrivateSubmissionGuard({
    model: modelId,
    quantity: seconds,
    unitMultiplier: videoRateMultiplier(modelId, DERIVE_RESOLUTION),
  })

  const submit = async () => {
    if (!(await onSubmit({ mode, prompt, seconds }))) return
    useStore.getState().showToast(t('derive.submitted', { label }), 'success')
    onClose()
  }

  return (
    <Dialog onClose={onClose} tier={tier} title={title} className="max-w-sm">
      <div className={`${LABEL} mb-1.5`}>{t('field.description')}</div>
      <Textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={3}
        aria-label={t('field.description')}
        placeholder={placeholder}
        className="resize-none"
      />

      <div className="mt-3">
        {mode === 'extend' ? (
          <SettingsChoice
            label={t('derive.extendLabel')}
            options={VIDEO_EXTEND_SECONDS}
            value={extendSeconds}
            render={(option) => t('shared.seconds', { seconds: option })}
            onChange={setExtendSeconds}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('derive.keepDuration', {
              seconds: sourceSeconds,
              resolution: DERIVE_RESOLUTION,
            })}
          </p>
        )}
      </div>

      <div className={`${PANEL_SECTION} mt-4`}>
        {guard.blocked && guard.disabledReason && (
          <p className="mb-1.5 text-label-sm text-destructive dark:text-destructive">
            {guard.disabledReason}
          </p>
        )}
        <SubmissionBillingAction
          blockedAction={guard.blockedAction}
          className="mb-1.5 text-label-sm"
        />
        <Button
          size="sm"
          type="button"
          disabled={guard.blocked || !prompt.trim()}
          title={guard.disabledReason}
          onClick={() => void submit()}
          className="w-full"
        >
          {guard.estimatedCredits === undefined ? (
            label
          ) : (
            <>
              {label} · <Credits credits={guard.estimatedCredits} />
            </>
          )}
        </Button>
      </div>
    </Dialog>
  )
}
