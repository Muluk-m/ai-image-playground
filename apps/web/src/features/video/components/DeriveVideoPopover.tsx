import { type VideoDeriveMode, videoRateMultiplier } from '@image-playground/shared'
import { useState } from 'react'
import Credits from '../../../components/Credits'
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
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { DEFAULT_EXTEND_SECONDS, DERIVE_RESOLUTION, VIDEO_EXTEND_SECONDS } from '../lib/derive'
import { videoDeriveLabel } from '../lib/labels'
import ChipRow from './ChipRow'

/** 续写 / 改视频弹窗。导演台与画布共用：谁的源片、提交到哪由调用方给。 */
export default function DeriveVideoPopover({
  sourceSeconds,
  mode,
  modelId,
  tier = 'raised',
  onSubmit,
  onClose,
}: {
  /** 源片时长。改视频保持它；续写另选秒数。 */
  sourceSeconds: number
  mode: VideoDeriveMode
  modelId: string
  tier?: 'raised' | 'alert'
  /** 受理了返回 true，弹窗随即关闭并提示已提交。 */
  onSubmit: (input: { mode: VideoDeriveMode; prompt: string; seconds: number }) => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useTranslation('video')
  const [prompt, setPrompt] = useState('')
  const [extendSeconds, setExtendSeconds] = useState<number>(DEFAULT_EXTEND_SECONDS)
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
    <Overlay onClose={onClose} tier={tier}>
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/50 bg-card p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in border-border dark:ring-white/10">
        <h3 className={`${PANEL_TITLE} mb-3`}>{title}</h3>

        <div className={`${LABEL} mb-1.5`}>{t('field.description')}</div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          aria-label={t('field.description')}
          placeholder={placeholder}
          className={`${FIELD} resize-none`}
        />

        <div className="mt-3">
          {mode === 'extend' ? (
            <ChipRow
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
            <p className="mb-1.5 text-[11px] text-destructive dark:text-destructive">
              {guard.disabledReason}
            </p>
          )}
          <SubmissionBillingAction
            blockedAction={guard.blockedAction}
            className="mb-1.5 text-[11px]"
          />
          <button
            type="button"
            disabled={guard.blocked || !prompt.trim()}
            title={guard.disabledReason}
            onClick={() => void submit()}
            className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
          >
            {guard.estimatedCredits === undefined ? (
              label
            ) : (
              <>
                {label} · <Credits credits={guard.estimatedCredits} />
              </>
            )}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
