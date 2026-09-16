import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon, SettingsIcon } from '../../../components/icons'
import { compactModelName } from '../../../components/ModelIdentity'
import ParamControls, { type UnsupportedParam } from '../../../components/ParamControls'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { useStore } from '../../../store'
import { INK, INK_3, PANEL_SHADOW, PANEL_SURFACE } from '../agentStyles'

/**
 * 智能体这条路做不到的两项，chip 不出现。理由见 `lib/turnParams.ts`：
 * 透明是浏览器里的抠色流水线，防改写是给提示词加前缀而提示词由模型在服务端写。
 */
const UNSUPPORTED: ReadonlySet<UnsupportedParam> = new Set(['transparent', 'noRewrite'])

/** 收起时只给一行摘要：当前打哪个模型、出多大、出几张。 */
function useSummary(): string[] {
  const { t } = useTranslation('agent')
  const params = useStore((state) => state.params)
  const settings = useStore((state) => state.settings)
  return useMemo(() => {
    const profile = clientProfileToApiProfile(getActiveApiProfile(settings))
    const parts = [compactModelName(profile.model, profile.model)]
    parts.push(params.size && params.size !== 'auto' ? params.size : t('params.autoSize'))
    if (params.n > 1) parts.push(t('params.imageCount', { count: params.n }))
    return parts
  }, [params.size, params.n, settings, t])
}

export default function AgentParamsChip() {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const summary = useSummary()

  // 点到面板外面就收起来；浮层盖在画布上，不收起会一直挡着。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={wrapperRef} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('params.title')}
        className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-white/[0.09] px-2.5 py-1 text-[11px] transition-colors hover:bg-white/[0.06] ${INK_3}`}
        onClick={() => setOpen((was) => !was)}
      >
        <SettingsIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="truncate">{summary.join(' · ')}</span>
        <ChevronDownIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
      </button>

      {open && (
        <div
          className={`absolute bottom-full left-0 z-10 mb-2 w-[19rem] rounded-xl p-3 ${PANEL_SURFACE} ${PANEL_SHADOW}`}
        >
          <p className={`mb-2 text-xs font-semibold ${INK}`}>{t('params.title')}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <ParamControls showCount unsupported={UNSUPPORTED} />
          </div>
          <p className={`mt-2 text-[11px] leading-relaxed ${INK_3}`}>{t('params.note')}</p>
        </div>
      )}
    </div>
  )
}
