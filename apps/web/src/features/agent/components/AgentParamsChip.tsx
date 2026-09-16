import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon, SettingsIcon } from '../../../components/icons'
import { compactModelName } from '../../../components/ModelIdentity'
import ParamControls, { type UnsupportedParam } from '../../../components/ParamControls'
import { useCloseOnEscape } from '../../../hooks/useCloseOnEscape'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { getParamCapabilities } from '../../../lib/paramCompatibility'
import { normalizeImageSize, sizeRatioLabel } from '../../../lib/size'
import { useStore } from '../../../store'
import { INK, INK_3, PANEL_SHADOW, PANEL_SURFACE } from '../agentStyles'

/**
 * 智能体这条路做不到的两项，chip 不出现。理由见 `lib/turnParams.ts`：
 * 透明是浏览器里的抠色流水线，防改写是给提示词加前缀而提示词由模型在服务端写。
 */
const UNSUPPORTED: ReadonlySet<UnsupportedParam> = new Set(['transparent', 'noRewrite'])

/** 收起时只给一行摘要：当前打哪个模型、出多大、出几张。 */
function useSummary(): string[] {
  const params = useStore((state) => state.params)
  const settings = useStore((state) => state.settings)
  return useMemo(() => {
    const active = getActiveApiProfile(settings)
    const profile = clientProfileToApiProfile(active)
    const capabilities = getParamCapabilities(active, params.output_format)
    const parts = [compactModelName(profile.model, profile.model)]
    parts.push(
      profile.provider === 'gemini'
        ? params.gemini_aspect_ratio || '自动比例'
        : params.size && params.size !== 'auto'
          ? capabilities.size
            ? normalizeImageSize(params.size)
            : sizeRatioLabel(params.size)
          : capabilities.size
            ? '自动尺寸'
            : '自动比例',
    )
    if (params.n > 1) parts.push(`${params.n} 张`)
    return parts
  }, [params, settings])
}

export default function AgentParamsChip() {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const summary = useSummary()
  const insidePointerRef = useRef<Event | null>(null)
  useCloseOnEscape(open, () => setOpen(false))

  // 点到面板外面就收起来；浮层盖在画布上，不收起会一直挡着。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (insidePointerRef.current === event) return
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  return (
    <div
      ref={wrapperRef}
      className="min-w-0"
      onPointerDownCapture={(event) => {
        // React capture includes child portals, unlike DOM contains().
        insidePointerRef.current = event.nativeEvent
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label="生成参数"
        className={`flex min-w-0 max-w-full items-center h-8 gap-1.5 rounded-full bg-muted px-2.5 text-[11px] transition-colors hover:bg-muted ${INK_3}`}
        onClick={() => setOpen((was) => !was)}
      >
        <SettingsIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="truncate" title={summary.join(' · ')}>
          {summary.join(' · ')}
        </span>
        <ChevronDownIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
      </button>

      {open && (
        <div
          className={`studio-agent-params absolute bottom-full right-0 z-10 mb-2 w-[19rem] max-w-[calc(100vw-2rem)] rounded-xl p-3 ${PANEL_SURFACE} ${PANEL_SHADOW}`}
        >
          <div className="mb-2 flex items-center justify-between">
            <p className={`text-xs font-semibold ${INK}`}>生成参数</p>
            <button
              type="button"
              aria-label="关闭生成参数"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground"
            >
              完成
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <ParamControls showCount unsupported={UNSUPPORTED} />
          </div>
          <p className={`mt-2 text-[11px] leading-relaxed ${INK_3}`}>
            改完下一轮生效，跑着的这一轮按起轮时的参数走。
          </p>
        </div>
      )}
    </div>
  )
}
