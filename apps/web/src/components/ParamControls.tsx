import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clientProfileToApiProfile,
  getActiveApiProfile,
  normalizeSettings,
} from '../lib/apiProfiles'
import { getProfileModelOptions, updateSelectedModel } from '../lib/channels/profileSelectors'
import { getPublicChannels } from '../lib/channels/publicChannels'
import { getOutputImageLimitForSettings, getParamCapabilities } from '../lib/paramCompatibility'
import { normalizeImageSize } from '../lib/size'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { useStore } from '../store'
import {
  DEFAULT_PARAMS,
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
  type TaskParams,
} from '../types'
import { ChipIcons } from './chipIcons'
import ParamChip from './ParamChip'
import Select from './Select'
import SizePickerModal from './SizePickerModal'

/** chip 模式 Select trigger：让 trigger 充满 chip wrapper（由 wrapperClassName='absolute inset-0' 提供），chevron 靠右对齐。 */
const CHIP_TRIGGER_CLASS = '!justify-end !bg-transparent !border-0 !shadow-none !px-3 !py-0 h-full'
const CHIP_WRAPPER_CLASS = 'absolute inset-0'

/** chip 模式 Select 的固定壳：trigger 隐藏自带 label（label/value 由 ParamChip 渲染），整个 chip 区域可点。 */
function ChipSelect<T extends string>(props: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ label: string; value: string }>
}) {
  return (
    <Select
      value={props.value}
      onChange={(v) => props.onChange(v as T)}
      options={[...props.options]}
      className={CHIP_TRIGGER_CLASS}
      wrapperClassName={CHIP_WRAPPER_CLASS}
      hideSelectedLabel
    />
  )
}

type GeminiSelectField = 'gemini_aspect_ratio' | 'gemini_image_size' | 'gemini_thinking_level'

const buildAutoOptions = (values: readonly string[]) => [
  { label: 'auto', value: 'auto' },
  ...values.map((v) => ({ label: v, value: v })),
]

const ON_OFF_OPTIONS = [
  { label: 'off', value: 'off' },
  { label: 'on', value: 'on' },
]

const GEMINI_FIELDS: ReadonlyArray<{
  label: string
  field: GeminiSelectField
  icon: ReactNode
  options: ReadonlyArray<{ label: string; value: string }>
}> = [
  {
    label: '比例',
    field: 'gemini_aspect_ratio',
    icon: ChipIcons.aspect,
    options: buildAutoOptions(GEMINI_ASPECT_RATIOS),
  },
  {
    label: '分辨率',
    field: 'gemini_image_size',
    icon: ChipIcons.imageSize,
    options: buildAutoOptions(GEMINI_IMAGE_SIZES),
  },
  {
    label: '思考',
    field: 'gemini_thinking_level',
    icon: ChipIcons.thinking,
    options: buildAutoOptions(GEMINI_THINKING_LEVELS),
  },
]

/**
 * 参数控制条：自包含的 chip 列表（模型 / 尺寸 / Gemini 三件套 / 质量 / 格式 / 压缩 / 审核 / 数量）。
 * 全部读写全局 store（settings/params 等），两个宿主（工作台 InputBar、创作模式 CanvasGenerateBar）
 * 天然共享同一份状态。数量 n chip 仅在 showCount 时渲染（创作模式 n 恒为 1，不显示）。
 */
export default function ParamControls({ showCount = false }: { showCount?: boolean }) {
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const reusedTaskApiProfileId = useStore((s) => s.reusedTaskApiProfileId)
  const profileModelCache = useStore((s) => s.profileModelCache)

  const currentActiveProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeProfile = useMemo(
    () =>
      settings.reuseTaskApiProfileTemporarily && reusedTaskApiProfileId
        ? (settings.profiles.find((profile) => profile.id === reusedTaskApiProfileId) ??
          currentActiveProfile)
        : currentActiveProfile,
    [currentActiveProfile, reusedTaskApiProfileId, settings],
  )
  const effectiveSettings = useMemo(
    () =>
      activeProfile.id === currentActiveProfile.id
        ? settings
        : normalizeSettings({ ...settings, activeProfileId: activeProfile.id }),
    [activeProfile.id, currentActiveProfile.id, settings],
  )
  const activeView = clientProfileToApiProfile(activeProfile)
  const isGeminiProvider = activeView.provider === 'gemini'
  const capabilities = getParamCapabilities(activeProfile, params.output_format)
  const outputImageLimit = getOutputImageLimitForSettings(effectiveSettings)
  const displaySize = normalizeImageSize(params.size) || DEFAULT_PARAMS.size
  const qualityOptions = [
    { label: 'auto', value: 'auto' },
    { label: 'low', value: 'low' },
    { label: 'medium', value: 'medium' },
    { label: 'high', value: 'high' },
  ]

  const [showSizePicker, setShowSizePicker] = useState(false)
  const [outputCompressionInput, setOutputCompressionInput] = useState(
    params.output_compression == null ? '' : String(params.output_compression),
  )
  const [nInput, setNInput] = useState(String(params.n))
  const [nInputFocused, setNInputFocused] = useState(false)
  const [nLimitHintVisible, setNLimitHintVisible] = useState(false)
  const nLimitHintTimerRef = useRef<number | null>(null)

  useEffect(() => {
    setOutputCompressionInput(
      params.output_compression == null ? '' : String(params.output_compression),
    )
  }, [params.output_compression])

  useEffect(() => {
    setNInput(String(params.n))
  }, [params.n])

  useEffect(
    () => () => {
      if (nLimitHintTimerRef.current != null) {
        window.clearTimeout(nLimitHintTimerRef.current)
      }
    },
    [],
  )

  const commitOutputCompression = useCallback(() => {
    if (outputCompressionInput.trim() === '') {
      setOutputCompressionInput('')
      setParams({ output_compression: null })
      return
    }

    const nextValue = Number(outputCompressionInput)
    if (Number.isNaN(nextValue)) {
      setOutputCompressionInput(
        params.output_compression == null ? '' : String(params.output_compression),
      )
      return
    }

    setOutputCompressionInput(String(nextValue))
    setParams({ output_compression: nextValue })
  }, [outputCompressionInput, params.output_compression, setParams])

  const commitN = useCallback(() => {
    setNLimitHintVisible(false)
    if (nLimitHintTimerRef.current != null) {
      window.clearTimeout(nLimitHintTimerRef.current)
      nLimitHintTimerRef.current = null
    }
    const nextValue = Number(nInput)
    const normalizedValue =
      nInput.trim() === '' ? DEFAULT_PARAMS.n : Number.isNaN(nextValue) ? params.n : nextValue
    const clampedValue = Math.min(outputImageLimit, Math.max(1, normalizedValue))
    setNInput(String(clampedValue))
    setParams({ n: clampedValue })
  }, [nInput, outputImageLimit, params.n, setParams])

  const showNLimitHint = useCallback(() => {
    setNLimitHintVisible(true)
    if (nLimitHintTimerRef.current != null) {
      window.clearTimeout(nLimitHintTimerRef.current)
    }
    nLimitHintTimerRef.current = window.setTimeout(() => {
      setNLimitHintVisible(false)
      nLimitHintTimerRef.current = null
    }, 2000)
  }, [])

  const hideNLimitHint = useCallback(() => {
    setNLimitHintVisible(false)
    if (nLimitHintTimerRef.current != null) {
      window.clearTimeout(nLimitHintTimerRef.current)
      nLimitHintTimerRef.current = null
    }
  }, [])

  const handleNInputChange = useCallback(
    (value: string) => {
      setNInput(value)
      const nextValue = Number(value)
      if (!Number.isNaN(nextValue) && nextValue > outputImageLimit) {
        showNLimitHint()
      } else {
        hideNLimitHint()
      }
    },
    [hideNLimitHint, outputImageLimit, showNLimitHint],
  )

  const handleNLimitIncreaseAttempt = useCallback(
    (preventDefault: () => void) => {
      const currentValue = Number(nInput)
      const effectiveValue = Number.isNaN(currentValue) ? params.n : currentValue
      if (!nInputFocused || effectiveValue < outputImageLimit) return

      preventDefault()
      showNLimitHint()
    },
    [nInput, nInputFocused, outputImageLimit, params.n, showNLimitHint],
  )

  // 跨 profile 模型快选：每个 profile 的 (model + 上游拉取缓存) 扁平去重，
  // 切换时同时切换 activeProfileId 与该 profile 的 model。
  const globalModelOptions = useMemo(() => {
    const publicChannels = getPublicChannels()
    return settings.profiles.flatMap((profile) => {
      const view = clientProfileToApiProfile(profile)
      const presetOptions = getProfileModelOptions(profile, publicChannels)
      const knownIds = new Set(presetOptions.map((o) => o.id))
      const cachedExtras = (profileModelCache[profile.id] ?? [])
        .filter((id) => !knownIds.has(id))
        .map((id) => ({ id, label: id }))
      const allOptions = [...presetOptions, ...cachedExtras]
      return allOptions.map((option) => ({
        profileId: profile.id,
        profileName: view.name,
        model: option.id,
        modelLabel: option.label,
        value: `${profile.id}::${option.id}`,
      }))
    })
  }, [settings.profiles, profileModelCache])
  const currentModelValue = `${activeProfile.id}::${activeView.model}`
  const handleGlobalModelPick = (rawValue: string) => {
    const option = globalModelOptions.find((o) => o.value === rawValue)
    if (!option) return
    if (option.profileId === activeProfile.id && option.model === activeView.model) return
    const publicChannels = getPublicChannels()
    const nextProfiles = settings.profiles.map((profile) =>
      profile.id === option.profileId
        ? updateSelectedModel(profile, option.model, publicChannels)
        : profile,
    )
    setSettings({ profiles: nextProfiles, activeProfileId: option.profileId })
  }

  // Model chip 只显示 modelLabel；profileName 留在下拉里 + tooltip，控制 chip 宽度。
  const modelLine =
    globalModelOptions.find((o) => o.value === currentModelValue)?.modelLabel ?? '未选择'

  return (
    <>
      {globalModelOptions.length > 0 && (
        <ParamChip
          icon={ChipIcons.model}
          label={modelLine}
          className="min-w-[150px] max-w-[200px] flex-shrink"
        >
          <ChipSelect
            value={currentModelValue}
            onChange={(val) => handleGlobalModelPick(val)}
            options={globalModelOptions.map((o) => ({
              label: `${o.modelLabel} · ${o.profileName}`,
              value: o.value,
            }))}
          />
        </ParamChip>
      )}
      {!isGeminiProvider && (
        <ParamChip
          icon={ChipIcons.size}
          label="尺寸"
          value={displaySize}
          onClick={() => {
            dismissAllTooltips()
            setShowSizePicker(true)
          }}
        />
      )}
      {isGeminiProvider &&
        GEMINI_FIELDS.map(({ label, field, icon, options }) => {
          const currentValue = (params[field] as string | undefined) ?? 'auto'
          return (
            <ParamChip key={field} icon={icon} label={label} value={currentValue}>
              <ChipSelect
                value={currentValue}
                onChange={(val) =>
                  setParams({
                    [field]: val === 'auto' ? undefined : val,
                  } as Partial<TaskParams>)
                }
                options={options}
              />
            </ParamChip>
          )
        })}
      {!isGeminiProvider && (
        <>
          {/* 不可用的参数 chip（codexCli / 模型不支持 quality；非 jpeg/webp 的压缩；
              Responses API 下的审核）直接不渲染，避免「灰着但点不开」的占位挤掉单行布局。 */}
          {capabilities.quality && (
            <ParamChip icon={ChipIcons.quality} label="质量" value={params.quality}>
              <ChipSelect
                value={params.quality}
                onChange={(val) => setParams({ quality: val as any })}
                options={qualityOptions}
              />
            </ParamChip>
          )}
          <ParamChip
            icon={ChipIcons.format}
            label="格式"
            value={params.output_format.toUpperCase()}
          >
            <ChipSelect
              value={params.output_format}
              onChange={(val) =>
                setParams({
                  output_format: val as TaskParams['output_format'],
                  ...(val === 'png' ? { output_compression: null } : { transparent_output: false }),
                })
              }
              options={[
                { label: 'PNG', value: 'png' },
                { label: 'JPEG', value: 'jpeg' },
                { label: 'WebP', value: 'webp' },
              ]}
            />
          </ParamChip>
          {capabilities.transparentOutput && (
            <ParamChip
              icon={ChipIcons.format}
              label="透明"
              value={params.transparent_output ? 'on' : 'off'}
            >
              <ChipSelect
                value={params.transparent_output ? 'on' : 'off'}
                onChange={(val) =>
                  setParams({
                    transparent_output: val === 'on',
                    output_compression: null,
                  })
                }
                options={ON_OFF_OPTIONS}
              />
            </ParamChip>
          )}
          {/* 防改写：prompt 前加 guard 前缀阻止 Codex 系网关重写提示词。默认开启。 */}
          <ParamChip
            icon={ChipIcons.noRewrite}
            label="防改写"
            value={params.no_rewrite ? 'on' : 'off'}
          >
            <ChipSelect
              value={params.no_rewrite ? 'on' : 'off'}
              onChange={(val) => setParams({ no_rewrite: val === 'on' })}
              options={ON_OFF_OPTIONS}
            />
          </ParamChip>
          {capabilities.compression && (
            <ParamChip icon={ChipIcons.compression} label="压缩">
              <input
                value={outputCompressionInput}
                onChange={(e) => setOutputCompressionInput(e.target.value)}
                onBlur={commitOutputCompression}
                type="number"
                min={0}
                max={100}
                placeholder="0-100"
                className="w-12 bg-transparent text-xs font-medium text-gray-700 outline-none dark:text-gray-200"
              />
            </ParamChip>
          )}
          {capabilities.moderation && (
            <ParamChip icon={ChipIcons.moderation} label="审核" value={params.moderation}>
              <ChipSelect
                value={params.moderation}
                onChange={(val) => setParams({ moderation: val as any })}
                options={[
                  { label: 'auto', value: 'auto' },
                  { label: 'low', value: 'low' },
                ]}
              />
            </ParamChip>
          )}
        </>
      )}
      {showCount && (
        <ParamChip icon={ChipIcons.count} label="数量">
          <input
            value={nInput}
            onChange={(e) => handleNInputChange(e.target.value)}
            onFocus={() => setNInputFocused(true)}
            onBlur={() => {
              setNInputFocused(false)
              commitN()
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') {
                handleNLimitIncreaseAttempt(() => e.preventDefault())
              }
            }}
            onWheel={(e) => {
              if (e.deltaY < 0) {
                handleNLimitIncreaseAttempt(() => e.preventDefault())
              }
            }}
            type="number"
            min={1}
            max={outputImageLimit}
            className="w-7 bg-transparent text-xs font-medium text-gray-500 outline-none dark:text-gray-400"
          />
        </ParamChip>
      )}
      {showSizePicker && (
        <SizePickerModal
          currentSize={params.size}
          onSelect={(size) => setParams({ size })}
          onClose={() => setShowSizePicker(false)}
          allowAuto={true}
        />
      )}
    </>
  )
}
