import { useState } from 'react'
import Overlay from '../../../components/Overlay'
import ParamControls from '../../../components/ParamControls'
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
import type { CanvasEditor } from '../lib/editor'
import { submitFromCanvas } from '../lib/submitFromCanvas'

/**
 * 批量生成：同一句话对选中的每张图各跑一次。入口在画布底部的批量条上，不在生成栏里——
 * 开了智能体的部署没有生成栏，而「把这一批都改成某样」正是那种部署里最常见的活。
 */
export default function CanvasBatchPromptDialog({
  editor,
  imageCount,
  onClose,
}: {
  editor: CanvasEditor
  imageCount: number
  onClose: () => void
}) {
  const { t } = useTranslation('canvas')
  const [prompt, setPrompt] = useState('')
  const params = useStore((state) => state.params)
  const settings = useStore((state) => state.settings)
  const quantity = Math.max(1, params.n)
  const guard = usePrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    // 整批的量：张数 × 每张份数。门禁要在发之前就知道这一次要花多少。
    quantity: quantity * imageCount,
  })

  const submit = () => {
    void submitFromCanvas(editor, prompt, { perImage: true })
    onClose()
  }

  return (
    // modal 档（z-50）：「更多」和模型下拉是 Radix 的 portal，自身也是 z-50，
    // 放进 raised(z-100) 的浮层里会被整片盖住，点开什么都看不见。
    <Overlay onClose={onClose}>
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10">
        <h3 className={`${PANEL_TITLE} mb-1.5`}>{t('batch.generateTitle')}</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {t('batch.generateHint', { count: imageCount, each: quantity })}
        </p>

        <div className={`${LABEL} mb-1.5`}>{t('batch.generatePromptLabel')}</div>
        <textarea
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
          placeholder={t('batch.generatePlaceholder')}
          aria-label={t('batch.generatePromptLabel')}
          className={`${FIELD} resize-none`}
        />

        {/* ParamControls 只给一串 chip，行布局由调用方出（与输入框那条同一套）。 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ParamControls showCount collapsible />
        </div>

        <div className={`${PANEL_SECTION} mt-3`}>
          {guard.blocked && guard.disabledReason && (
            <p className="mb-1.5 text-[11px] text-destructive">{guard.disabledReason}</p>
          )}
          <SubmissionBillingAction
            blockedAction={guard.blockedAction}
            className="mb-1.5 text-[11px]"
          />
          <button
            type="button"
            disabled={guard.blocked || prompt.trim().length === 0}
            title={guard.disabledReason}
            onClick={submit}
            className={`${PRIMARY_BUTTON} w-full disabled:cursor-not-allowed`}
          >
            {t('batch.generateSubmit', { count: imageCount })}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
