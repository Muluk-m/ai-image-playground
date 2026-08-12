import { useEffect, useMemo, useRef, useState } from 'react'
import {
  calculateImageSize,
  normalizeCodexCliImageSize,
  normalizeImageSize,
  parseRatio,
  type SizeTier,
  sameAspectRatio,
  sizeRatioLabel,
} from '../lib/size'
import Overlay from './Overlay'
import ViewportTooltip from './ViewportTooltip'

const TIERS: SizeTier[] = ['1K', '2K', '4K']
const SIZE_LIMIT_TEXT =
  '由于模型限制，不符合要求的分辨率会被自动规整：\n宽高均为 16 的倍数，最大边长 3840px，宽高比不超过 3:1，总像素限制为 655360-8294400。'
const LIMITED_SIZE_LIMIT_TEXT =
  '由于模型限制，不符合要求的分辨率会被自动规整：\n宽高均为 16 的倍数，宽高比不超过 3:1，分辨率不超过 1K。'
const LIMITED_TIER_HINT_TEXT = '当前模型不支持 1K 以上的分辨率'
const LIMITED_TIER_DESCRIPTION_ID = 'size-picker-limited-tier-description'
const CLAMPED_SIZE_TEXT = '由于模型限制，原始分辨率已被自动规整'
const RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '21:9', value: '21:9' },
]

interface Props {
  currentSize: string
  onSelect: (size: string) => void
  onClose: () => void
  allowAuto?: boolean
  /** 不支持 size capability 的模型只选择构图比例，不展示或承诺具体分辨率。 */
  ratioOnly?: boolean
  /** Codex CLI 的分辨率限制到 1K，2K/4K 档禁用。 */
  limitTo1K?: boolean
}

type Mode = 'auto' | 'ratio' | 'resolution'

function parseSize(size: string) {
  const match = size.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/)
  if (!match) return null
  return { width: match[1], height: match[2] }
}

function findPresetForSize(size: string, matchByRatio = false) {
  // 比例模式只关心构图；1K 受限模型的落盘尺寸也可能被上游重新量化
  // （如 1024x1824 → 941x1672）。两者都按 1K 预设做宽高比容差匹配。
  if (matchByRatio) {
    for (const ratio of RATIOS) {
      const presetSize = calculateImageSize('1K', ratio.value)
      if (presetSize && sameAspectRatio(size, presetSize)) {
        return { tier: '1K' as const, ratio: ratio.value }
      }
    }
    return null
  }

  const normalized = normalizeImageSize(size)
  for (const tier of TIERS) {
    for (const ratio of RATIOS) {
      if (calculateImageSize(tier, ratio.value) === normalized) {
        return { tier, ratio: ratio.value }
      }
    }
  }
  return null
}

export default function SizePickerModal({
  currentSize,
  onSelect,
  onClose,
  allowAuto = true,
  ratioOnly = false,
  limitTo1K = false,
}: Props) {
  const currentPreset = findPresetForSize(currentSize, ratioOnly || limitTo1K)
  const currentParsedSize = parseSize(currentSize)
  const [mode, setMode] = useState<Mode>(() => {
    if (ratioOnly) return 'ratio'
    if (!currentSize || currentSize === 'auto') return allowAuto ? 'auto' : 'ratio'
    if (currentPreset) return 'ratio'
    return 'resolution'
  })

  // Ratio mode state
  const [tier, setTier] = useState<SizeTier>(currentPreset?.tier ?? '1K')
  const [ratio, setRatio] = useState(currentPreset?.ratio ?? (allowAuto ? '1:1' : '4:3'))
  const [customRatio, setCustomRatio] = useState('16:9')

  // Resolution mode state
  const [customW, setCustomW] = useState(currentParsedSize?.width ?? '1024')
  const [customH, setCustomH] = useState(currentParsedSize?.height ?? '1024')

  const [hintVisible, setHintVisible] = useState(false)
  const hintTimerRef = useRef<number | null>(null)
  const [tierHint, setTierHint] = useState<SizeTier | null>(null)
  const tierHintTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (hintTimerRef.current != null) window.clearTimeout(hintTimerRef.current)
      if (tierHintTimerRef.current != null) window.clearTimeout(tierHintTimerRef.current)
    },
    [],
  )

  const normalizeSize = limitTo1K ? normalizeCodexCliImageSize : normalizeImageSize
  const sizeLimitText = limitTo1K ? LIMITED_SIZE_LIMIT_TEXT : SIZE_LIMIT_TEXT

  const activeRatio = ratio === 'custom' ? customRatio : ratio
  const parsedCustomRatio = parseRatio(customRatio)
  const customRatioValid = ratio !== 'custom' || Boolean(parsedCustomRatio)
  const customRatioClamped = Boolean(
    ratio === 'custom' &&
      parsedCustomRatio &&
      Math.max(parsedCustomRatio.width, parsedCustomRatio.height) /
        Math.min(parsedCustomRatio.width, parsedCustomRatio.height) >
        3,
  )

  const previewSize = useMemo(() => {
    if (mode === 'auto') return 'auto'

    if (mode === 'ratio') {
      const size = calculateImageSize(ratioOnly ? '1K' : tier, activeRatio)
      return size ? normalizeSize(size) : ''
    }

    if (mode === 'resolution') {
      const w = parseInt(customW, 10)
      const h = parseInt(customH, 10)
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return normalizeSize(`${w}x${h}`)
      }
      return ''
    }

    return ''
  }, [mode, ratioOnly, tier, activeRatio, customW, customH, normalizeSize])

  const isClamped = useMemo(() => {
    if (ratioOnly) return false
    if (!previewSize || previewSize === 'auto') return false
    if (mode === 'ratio' && ratio === 'custom') return customRatioClamped
    if (mode === 'resolution') {
      const w = parseInt(customW, 10)
      const h = parseInt(customH, 10)
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return `${w}x${h}` !== previewSize
      }
    }
    return false
  }, [ratioOnly, mode, ratio, customRatioClamped, customW, customH, previewSize])

  const showHint = () => setHintVisible(true)
  const hideHint = () => {
    setHintVisible(false)
    clearHintTimer()
  }
  const clearHintTimer = () => {
    if (hintTimerRef.current != null) {
      window.clearTimeout(hintTimerRef.current)
      hintTimerRef.current = null
    }
  }
  const startHintTouch = () => {
    hintTimerRef.current = window.setTimeout(() => {
      setHintVisible(true)
      hintTimerRef.current = null
    }, 450)
  }

  const clearTierHintTimer = () => {
    if (tierHintTimerRef.current != null) {
      window.clearTimeout(tierHintTimerRef.current)
      tierHintTimerRef.current = null
    }
  }
  const scheduleTierHint = (value: SizeTier | null, delayMs: number) => {
    clearTierHintTimer()
    tierHintTimerRef.current = window.setTimeout(() => {
      setTierHint(value)
      tierHintTimerRef.current = null
    }, delayMs)
  }

  const applySize = () => {
    if (!previewSize) return
    onSelect(previewSize)
    onClose()
  }

  const buttonClass = (active: boolean) => {
    return `rounded-xl border px-3 py-2 text-sm transition ${
      active
        ? 'border-blue-400 bg-blue-50 text-blue-600 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-blue-300'
        : 'border-gray-200/70 bg-white/60 text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]'
    }`
  }

  return (
    <Overlay onClose={onClose} tier="modal">
      <div className="relative z-10 max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">
              {ratioOnly ? '设置画面比例' : '设置图像尺寸'}
            </h3>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              当前：{ratioOnly ? sizeRatioLabel(currentSize) : currentSize || 'auto'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-6">
          {!ratioOnly && (
            <div className="flex rounded-xl bg-gray-100/80 p-1 dark:bg-white/[0.04]">
              {allowAuto && (
                <button
                  onClick={() => setMode('auto')}
                  className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition ${mode === 'auto' ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-700 dark:text-gray-100' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
                >
                  自动
                </button>
              )}
              <button
                onClick={() => setMode('ratio')}
                className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition ${mode === 'ratio' ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-700 dark:text-gray-100' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
              >
                按比例
              </button>
              <button
                onClick={() => setMode('resolution')}
                className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition ${mode === 'resolution' ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-700 dark:text-gray-100' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
              >
                自定义宽高
              </button>
            </div>
          )}

          <div className="h-[380px] max-h-[55vh] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-white/10 pr-1 -mr-1 pb-2">
            {mode === 'auto' && (
              <div className="flex h-full animate-fade-in items-center justify-center pt-8 pb-4 text-center">
                <div>
                  <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 text-blue-500 dark:bg-blue-500/10">
                    <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      />
                    </svg>
                  </div>
                  <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">自动尺寸</h4>
                  <p className="mt-2 text-xs text-gray-400 leading-relaxed dark:text-gray-500">
                    不向模型传递具体的分辨率参数
                    <br />
                    由模型自己决定生成尺寸
                  </p>
                </div>
              </div>
            )}

            {mode === 'ratio' && (
              <div className="space-y-5 animate-fade-in">
                {!ratioOnly && (
                  <section>
                    <div className="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">
                      基准分辨率
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {TIERS.map((item) => {
                        const disabled = limitTo1K && item !== '1K'
                        // 指针悬停与键盘聚焦共用同一条展示路径
                        const revealTierHint = () => {
                          clearTierHintTimer()
                          if (disabled) setTierHint(item)
                        }
                        return (
                          // 触屏：长按 450ms 才显示提示，抬手后 1500ms 自动收起
                          <div
                            key={item}
                            className="relative"
                            onMouseEnter={revealTierHint}
                            onMouseLeave={() => setTierHint(null)}
                            onFocus={revealTierHint}
                            onBlur={() => setTierHint(null)}
                            onTouchStart={() => {
                              if (disabled) scheduleTierHint(item, 450)
                            }}
                            onTouchEnd={() => scheduleTierHint(null, 1500)}
                            onTouchCancel={() => {
                              clearTierHintTimer()
                              setTierHint(null)
                            }}
                          >
                            <button
                              className={`${buttonClass(tier === item)} w-full ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                              onClick={() => {
                                if (!disabled) setTier(item)
                              }}
                              aria-disabled={disabled}
                              aria-describedby={disabled ? LIMITED_TIER_DESCRIPTION_ID : undefined}
                            >
                              {item}
                            </button>
                            <ViewportTooltip
                              visible={tierHint === item}
                              className="w-52 text-center"
                            >
                              {LIMITED_TIER_HINT_TEXT}
                            </ViewportTooltip>
                          </div>
                        )
                      })}
                    </div>
                    {limitTo1K && (
                      <p id={LIMITED_TIER_DESCRIPTION_ID} className="sr-only">
                        {LIMITED_TIER_HINT_TEXT}
                      </p>
                    )}
                  </section>
                )}

                <section>
                  <div className="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">
                    图像比例
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {RATIOS.map((item) => {
                      const [w, h] = item.value.split(':').map(Number)
                      return (
                        <button
                          key={item.value}
                          className={`${buttonClass(ratio === item.value)} flex flex-col items-center justify-center gap-1.5 !py-2.5`}
                          onClick={() => setRatio(item.value)}
                        >
                          <div className="flex h-5 w-5 items-center justify-center">
                            {/* 长边占满预览框，短边按比例收缩 */}
                            <div
                              className="border-[1.5px] border-current rounded-[3px] opacity-60"
                              style={{
                                width: w >= h ? '100%' : `${(w / h) * 100}%`,
                                height: h >= w ? '100%' : `${(h / w) * 100}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs">{item.label}</span>
                        </button>
                      )
                    })}
                    <button
                      className={`${buttonClass(ratio === 'custom')} col-span-4`}
                      onClick={() => setRatio('custom')}
                    >
                      自定义比例
                    </button>
                  </div>
                </section>

                {ratio === 'custom' && (
                  <label className="block animate-fade-in">
                    <span className="mb-2 block text-xs font-medium text-gray-400 dark:text-gray-500">
                      输入自定义比例
                    </span>
                    <input
                      value={customRatio}
                      onChange={(e) => setCustomRatio(e.target.value)}
                      placeholder="例如 5:4 / 2.39:1"
                      className={`w-full rounded-xl border px-3 py-2 text-sm outline-none transition ${
                        customRatioValid
                          ? 'border-gray-200/70 bg-white/60 text-gray-700 focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'
                          : 'border-red-300 bg-white/60 text-gray-700 focus:border-red-400 dark:border-red-500/40 dark:bg-white/[0.03] dark:text-gray-200'
                      }`}
                    />
                  </label>
                )}

                {ratioOnly && (
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    最终像素数量由模型决定，仅保证所选宽高比例。
                  </p>
                )}
              </div>
            )}

            {!ratioOnly && mode === 'resolution' && (
              <div className="space-y-5 animate-fade-in">
                <section>
                  <div className="mb-4 text-xs font-medium text-gray-400 dark:text-gray-500">
                    输入具体像素值
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex-1">
                      <span className="mb-1.5 block text-xs text-gray-500 dark:text-gray-400">
                        宽度 (Width)
                      </span>
                      <input
                        type="number"
                        value={customW}
                        onChange={(e) => setCustomW(e.target.value)}
                        className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                        placeholder="例如 1024"
                      />
                    </label>
                    <div className="mt-5 text-gray-300 dark:text-gray-600">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </div>
                    <label className="flex-1">
                      <span className="mb-1.5 block text-xs text-gray-500 dark:text-gray-400">
                        高度 (Height)
                      </span>
                      <input
                        type="number"
                        value={customH}
                        onChange={(e) => setCustomH(e.target.value)}
                        className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                        placeholder="例如 1024"
                      />
                    </label>
                  </div>
                </section>
                <div className="rounded-xl border border-gray-200/80 bg-gray-50/80 p-3 text-xs text-gray-600 dark:border-white/[0.05] dark:bg-white/[0.02] dark:text-gray-400">
                  <div className="flex items-start gap-2">
                    <svg
                      className="mt-[2px] h-4 w-4 flex-shrink-0 text-blue-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <div className="whitespace-pre-line leading-relaxed">{sizeLimitText}</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl bg-gray-50 px-4 py-3 dark:bg-white/[0.03]">
            <div className="text-xs text-gray-400 dark:text-gray-500">将使用</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-lg font-semibold text-gray-800 dark:text-gray-100">
                {previewSize ? (ratioOnly ? sizeRatioLabel(previewSize) : previewSize) : '尺寸无效'}
              </span>
              {isClamped && (
                <div
                  className="relative flex items-center"
                  onMouseEnter={showHint}
                  onMouseLeave={hideHint}
                  onTouchStart={startHintTouch}
                  onTouchEnd={clearHintTimer}
                  onTouchCancel={hideHint}
                  onClick={showHint}
                >
                  <svg
                    className="w-5 h-5 text-yellow-500 cursor-pointer"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <ViewportTooltip
                    visible={hintVisible}
                    className="w-56 whitespace-pre-line text-center"
                  >
                    {CLAMPED_SIZE_TEXT}
                  </ViewportTooltip>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-gray-100 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
          >
            取消
          </button>
          <button
            onClick={applySize}
            disabled={!previewSize}
            className="flex-1 rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            确定
          </button>
        </div>
      </div>
    </Overlay>
  )
}
