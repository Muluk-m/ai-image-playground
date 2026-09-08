import {
  VIDEO_DERIVE_LABELS,
  type VideoDeriveMode,
  videoRateMultiplier,
} from '@image-playground/shared'
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
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { DEFAULT_EXTEND_SECONDS, DERIVE_RESOLUTION, VIDEO_EXTEND_SECONDS } from '../lib/derive'
import { useVideoStore } from '../store'
import type { VideoTask } from '../types'
import ChipRow from './ChipRow'

const TITLES: Record<VideoDeriveMode, string> = {
  extend: '续写 · 从最后一帧往后',
  edit: '改视频 · 保留画面改内容',
}

const PLACEHOLDERS: Record<VideoDeriveMode, string> = {
  extend: '接下来发生什么，镜头怎么动',
  edit: '改什么，保留什么',
}

export default function DeriveVideoPopover({
  task,
  mode,
  modelId,
  tier = 'raised',
  onClose,
}: {
  task: VideoTask
  mode: VideoDeriveMode
  modelId: string
  tier?: 'raised' | 'alert'
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState('')
  const [extendSeconds, setExtendSeconds] = useState<number>(DEFAULT_EXTEND_SECONDS)
  const seconds = mode === 'edit' ? task.duration : extendSeconds
  const label = VIDEO_DERIVE_LABELS[mode]

  const guard = usePrivateSubmissionGuard({
    model: modelId,
    quantity: seconds,
    unitMultiplier: videoRateMultiplier(modelId, DERIVE_RESOLUTION),
  })

  const submit = async () => {
    const id = await useVideoStore.getState().deriveVideo(task, { mode, prompt, seconds })
    if (!id) return
    useStore.getState().showToast(`已提交${label}`, 'success')
    onClose()
  }

  return (
    <Overlay onClose={onClose} tier={tier}>
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/50 bg-white p-4 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10">
        <h3 className={`${PANEL_TITLE} mb-3`}>{TITLES[mode]}</h3>

        <div className={`${LABEL} mb-1.5`}>描述</div>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          aria-label="描述"
          placeholder={PLACEHOLDERS[mode]}
          className={`${FIELD} resize-none`}
        />

        <div className="mt-3">
          {mode === 'extend' ? (
            <ChipRow
              label="接多长"
              options={VIDEO_EXTEND_SECONDS}
              value={extendSeconds}
              render={(option) => `${option} 秒`}
              onChange={setExtendSeconds}
            />
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              沿用 {task.duration} 秒 · 最高 {DERIVE_RESOLUTION}
            </p>
          )}
        </div>

        <div className={`${PANEL_SECTION} mt-4`}>
          {guard.blocked && guard.disabledReason && (
            <p className="mb-1.5 text-[11px] text-red-600 dark:text-red-400">
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
            {guard.estimatedCredits === undefined
              ? label
              : `${label} · ${guard.estimatedCredits} 积分`}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
