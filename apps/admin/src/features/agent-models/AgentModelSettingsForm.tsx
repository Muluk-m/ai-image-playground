import {
  AGENT_PROFILE_KEYS,
  AGENT_PROVIDER_APIS,
  AGENT_PROVIDER_SECRET_REFS,
  type AgentConfiguredModel,
  type AgentModelBinding,
  type AgentModelProbeResult,
  type AgentModelSettings,
  type AgentModelSettingsView,
  type AgentProfileKey,
  type AgentProviderSettings,
  MODEL_REASONING_LEVELS,
  type ModelReasoningLevel,
} from '@image-playground/shared'
import { Activity, Check, ChevronDown, ChevronRight, Plus, Save, Trash2 } from 'lucide-react'
import { type SetStateAction, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ApiError } from '@/lib/api-client'
import { formatAdminError } from '@/lib/format-error'
import { cn } from '@/lib/utils'

const DEPTH_LABELS: Record<AgentProfileKey, string> = {
  default: '默认',
  fast: '快速',
  medium: '普通',
  deep: '深度',
}

const DEPTH_HINTS: Record<AgentProfileKey, string> = {
  default: '未指定档位',
  fast: '低延迟',
  medium: '日常均衡',
  deep: '深度规划',
}

const EFFORT_LABELS: Record<ModelReasoningLevel, string> = {
  off: '关闭（off）',
  minimal: '最低（minimal）',
  low: '低（low）',
  medium: '中（medium）',
  high: '高（high）',
  xhigh: '更高（xhigh）',
  max: '最高（max）',
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** 没选备用时不提交这个键，避免把空值写进配置。 */
function settingsForSave(value: AgentModelSettings): AgentModelSettings {
  return {
    ...value,
    profiles: Object.fromEntries(
      AGENT_PROFILE_KEYS.map((key) => {
        const profile = value.profiles[key]
        if (profile.fallback) return [key, profile]
        const { fallback: _unused, ...rest } = profile
        return [key, rest]
      }),
    ) as AgentModelSettings['profiles'],
  }
}

function Choice({
  label,
  visibleLabel,
  value,
  options,
  disabled = false,
  compact = false,
  onChange,
}: {
  label: string
  visibleLabel?: string
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  compact?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="min-w-0 space-y-1">
      {visibleLabel !== '' ? (
        <p className="truncate text-xs font-medium text-muted-foreground">
          {visibleLabel ?? label}
        </p>
      ) : null}
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          aria-label={label}
          className={cn('w-full min-w-0 [&>span]:truncate', compact && 'h-8 text-xs')}
        >
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {options
            .filter((option) => option.value)
            .map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function Field({
  label,
  visibleLabel,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled = false,
  mono = false,
}: {
  label: string
  visibleLabel?: string
  value: string | number
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  mono?: boolean
}) {
  return (
    <label className="block min-w-0 space-y-1 text-xs font-medium text-muted-foreground">
      <span className="block truncate">{visibleLabel ?? label}</span>
      <Input
        aria-label={label}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        className={
          mono ? 'font-mono text-xs font-normal text-foreground' : 'font-normal text-foreground'
        }
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

export function AgentModelSettingsForm({
  initial,
  save,
  probe,
  pending,
  error,
}: {
  initial: AgentModelSettingsView
  save: (settings: AgentModelSettings, revision: number) => Promise<AgentModelSettingsView | void>
  probe?: (
    settings: AgentModelSettings,
    profile: AgentProfileKey,
    target: 'primary' | 'fallback',
  ) => Promise<AgentModelProbeResult>
  pending: boolean
  error: string | null
}) {
  const [baseline, setBaseline] = useState(initial)
  const [settings, setSettings] = useState(() => structuredClone(initial.settings))
  const [probingKey, setProbingKey] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, AgentModelProbeResult>>({})
  const probeEpochRef = useRef(0)

  const dirty = JSON.stringify(settings) !== JSON.stringify(baseline.settings)

  function updateSettings(next: SetStateAction<AgentModelSettings>) {
    probeEpochRef.current += 1
    setProbingKey(null)
    setSettings(next)
  }

  useEffect(() => {
    if (!dirty && initial.revision !== baseline.revision) {
      probeEpochRef.current += 1
      setBaseline(initial)
      setSettings(structuredClone(initial.settings))
      setProbingKey(null)
      setProbeResults({})
    }
  }, [baseline.revision, dirty, initial])

  function updateProvider(index: number, next: AgentProviderSettings) {
    setProbeResults({})
    updateSettings((current) => ({
      ...current,
      providers: current.providers.map((provider, i) => (i === index ? next : provider)),
    }))
  }

  function modelsFor(provider?: AgentProviderSettings): AgentConfiguredModel[] {
    if (!provider) return []
    const models = new Map(
      initial.templates
        .find((item) => item.id === provider.template)
        ?.models.map((model) => [model.id, model]),
    )
    for (const model of provider.models) models.set(model.id, model)
    return [...models.values()].filter((model) => model.imageInput)
  }

  function bindingInvalid(binding?: AgentModelBinding) {
    if (!binding) return false
    const provider = settings.providers.find((item) => item.id === binding.providerId)
    const model = modelsFor(provider).find((item) => item.id === binding.modelId)
    return !model || !model.reasoningLevels.includes(binding.reasoning)
  }

  const invalidProfiles = AGENT_PROFILE_KEYS.filter(
    (key) =>
      bindingInvalid(settings.profiles[key]) || bindingInvalid(settings.profiles[key].fallback),
  )

  function discard() {
    setBaseline(initial)
    updateSettings(structuredClone(initial.settings))
    setProbeResults({})
  }

  async function submit() {
    if (invalidProfiles.length) return
    const saved = await save(settingsForSave(settings), baseline.revision)
    if (saved) {
      setBaseline(saved)
      updateSettings(structuredClone(saved.settings))
      setProbeResults({})
    }
  }

  async function runProbe(profileKey: AgentProfileKey, target: 'primary' | 'fallback') {
    if (!probe || probingKey) return
    const slot = `${profileKey}:${target}`
    const epoch = probeEpochRef.current
    setProbingKey(slot)
    try {
      const result = await probe(settingsForSave(settings), profileKey, target)
      if (probeEpochRef.current !== epoch) return
      setProbeResults((current) => ({ ...current, [slot]: result }))
    } catch (err) {
      if (probeEpochRef.current !== epoch) return
      const message =
        typeof formatAdminError === 'function'
          ? formatAdminError(err)
          : err instanceof ApiError && err.message
            ? err.message
            : '探测请求失败'
      setProbeResults((current) => ({
        ...current,
        [slot]: { ok: false, status: 'failed', latencyMs: 0, message },
      }))
    } finally {
      if (probeEpochRef.current === epoch) {
        setProbingKey((current) => (current === slot ? null : current))
      }
    }
  }

  const saveDisabled =
    (!dirty && !initial.validationError) ||
    pending ||
    invalidProfiles.length > 0 ||
    initial.revision !== baseline.revision

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <fieldset disabled={pending} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono">
              版本 #{baseline.revision}
            </Badge>
            {dirty ? (
              <Badge variant="warning">未保存草稿</Badge>
            ) : (
              <span className="text-xs text-muted-foreground">已同步线上配置</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={(!dirty && initial.revision === baseline.revision) || pending}
              onClick={discard}
            >
              放弃修改
            </Button>
            <Button type="submit" size="sm" variant="brand" disabled={saveDisabled}>
              <Save className="size-3.5" />
              {pending ? '保存中…' : '保存配置'}
            </Button>
          </div>
        </div>

        {initial.validationError ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            {initial.validationError}
          </p>
        ) : null}

        {initial.revision !== baseline.revision ? (
          <p
            role="status"
            className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning"
          >
            服务器配置已有新版本，当前草稿已保留。请先放弃修改并载入新配置，再重新编辑。
          </p>
        ) : null}

        {invalidProfiles.length ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            请重新选择以下档位的模型和推理强度：
            {invalidProfiles.map((key) => DEPTH_LABELS[key]).join('、')}。模型必须支持图片输入。
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}

        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">思考档位路由</h2>
            <span className="text-xs text-muted-foreground">
              过载且未输出首包时自动切备用，只切换一次
            </span>
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            {AGENT_PROFILE_KEYS.map((key) => {
              const profile = settings.profiles[key]
              const provider = settings.providers.find((item) => item.id === profile.providerId)
              const models = modelsFor(provider)
              const selected = models.find((model) => model.id === profile.modelId)
              const primaryInvalid = bindingInvalid(profile)
              const primaryReady = initial.credentialReady[profile.providerId]

              function change(next: Partial<typeof profile>) {
                setProbeResults((current) => {
                  if (!(`${key}:primary` in current)) return current
                  const copy = { ...current }
                  delete copy[`${key}:primary`]
                  return copy
                })
                updateSettings((current) => ({
                  ...current,
                  profiles: { ...current.profiles, [key]: { ...profile, ...next } },
                }))
              }

              const fallback = profile.fallback
              const fallbackProvider = settings.providers.find(
                (item) => item.id === fallback?.providerId,
              )
              const fallbackModels = modelsFor(fallbackProvider)
              const fallbackSelected = fallbackModels.find((item) => item.id === fallback?.modelId)
              const fallbackInvalid = bindingInvalid(fallback)

              function changeFallback(next: AgentModelBinding | undefined) {
                setProbeResults((current) => {
                  if (!(`${key}:fallback` in current)) return current
                  const copy = { ...current }
                  delete copy[`${key}:fallback`]
                  return copy
                })
                updateSettings((current) => ({
                  ...current,
                  profiles: {
                    ...current.profiles,
                    [key]: { ...current.profiles[key], fallback: next },
                  },
                }))
              }

              const primaryProbe = probeResults[`${key}:primary`]
              const fallbackProbe = probeResults[`${key}:fallback`]

              return (
                <div
                  key={key}
                  className={cn(
                    'flex flex-col justify-between rounded-xl border bg-background p-4',
                    primaryInvalid && 'border-danger/60',
                  )}
                >
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2.5">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="px-2 py-0.5 font-semibold">
                          {DEPTH_LABELS[key]}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{DEPTH_HINTS[key]}</span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        {selected ? (
                          <span className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatCompactTokens(selected.contextWindow)} ctx
                          </span>
                        ) : null}
                        {primaryReady !== undefined ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span
                              className={cn(
                                'size-2 rounded-full',
                                primaryReady ? 'bg-success' : 'bg-warning',
                              )}
                              aria-hidden
                            />
                            {primaryReady ? '凭证就绪' : '缺密钥'}
                          </span>
                        ) : null}
                        {probe ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={primaryInvalid || probingKey !== null}
                            onClick={() => void runProbe(key, 'primary')}
                          >
                            <Activity className="size-3" />
                            {probingKey === `${key}:primary` ? '探测中' : '探测'}
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {primaryProbe ? (
                      <div
                        className={cn(
                          'rounded-md px-2.5 py-1.5 text-xs',
                          primaryProbe.ok
                            ? 'bg-success/10 text-success'
                            : primaryProbe.status === 'unconfigured'
                              ? 'bg-warning/10 text-warning'
                              : 'bg-danger/10 text-danger',
                        )}
                      >
                        {primaryProbe.ok
                          ? `主路由连通正常 · ${primaryProbe.latencyMs} ms`
                          : (primaryProbe.message ?? '探测未通过')}
                      </div>
                    ) : null}

                    <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.12fr)_minmax(0,1.58fr)_minmax(0,1.15fr)]">
                      <Choice
                        label={`${DEPTH_LABELS[key]} · Provider`}
                        visibleLabel="主 Provider"
                        value={profile.providerId}
                        options={settings.providers.map((item) => ({
                          value: item.id,
                          label: item.name || item.id,
                        }))}
                        onChange={(providerId) =>
                          change({ providerId, modelId: '', reasoning: 'off' })
                        }
                      />
                      <Choice
                        label={`${DEPTH_LABELS[key]} · 模型`}
                        visibleLabel="主模型"
                        value={profile.modelId}
                        options={models.map((item) => ({
                          value: item.id,
                          label: `${item.name} (${item.id})`,
                        }))}
                        onChange={(modelId) => {
                          const levels = models.find((item) => item.id === modelId)
                            ?.reasoningLevels ?? ['off']
                          change({
                            modelId,
                            reasoning: levels.includes(profile.reasoning)
                              ? profile.reasoning
                              : levels[0]!,
                          })
                        }}
                      />
                      <Choice
                        label={`${DEPTH_LABELS[key]} · 模型推理强度`}
                        visibleLabel="推理强度"
                        value={profile.reasoning}
                        options={(selected?.reasoningLevels ?? []).map((level) => ({
                          value: level,
                          label: EFFORT_LABELS[level],
                        }))}
                        onChange={(reasoning) =>
                          change({ reasoning: reasoning as ModelReasoningLevel })
                        }
                      />
                    </div>

                    <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5">
                      {fallback ? (
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-muted-foreground">
                                过载备用
                              </span>
                              <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                                已开启
                              </Badge>
                            </div>
                            {probe ? (
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                disabled={fallbackInvalid || probingKey !== null}
                                onClick={() => void runProbe(key, 'fallback')}
                              >
                                <Activity className="size-3" />
                                {probingKey === `${key}:fallback` ? '探测中' : '探测备用'}
                              </Button>
                            ) : null}
                          </div>

                          {fallbackProbe ? (
                            <div
                              className={cn(
                                'rounded-md px-2.5 py-1.5 text-xs',
                                fallbackProbe.ok
                                  ? 'bg-success/10 text-success'
                                  : fallbackProbe.status === 'unconfigured'
                                    ? 'bg-warning/10 text-warning'
                                    : 'bg-danger/10 text-danger',
                              )}
                            >
                              {fallbackProbe.ok
                                ? `备用路由连通正常 · ${fallbackProbe.latencyMs} ms`
                                : (fallbackProbe.message ?? '探测未通过')}
                            </div>
                          ) : null}

                          <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.12fr)_minmax(0,1.58fr)_minmax(0,1.15fr)]">
                            <Choice
                              label={`${DEPTH_LABELS[key]} · 过载备用 Provider`}
                              visibleLabel="备用 Provider"
                              value={fallback.providerId}
                              options={[
                                { value: '__none__', label: '不切换' },
                                ...settings.providers.map((item) => ({
                                  value: item.id,
                                  label: item.name || item.id,
                                })),
                              ]}
                              onChange={(providerId) => {
                                if (providerId === '__none__') {
                                  changeFallback(undefined)
                                  return
                                }
                                changeFallback({ providerId, modelId: '', reasoning: 'off' })
                              }}
                            />
                            <Choice
                              label={`${DEPTH_LABELS[key]} · 过载备用模型`}
                              visibleLabel="备用模型"
                              value={fallback.modelId || '__unset__'}
                              options={fallbackModels.map((item) => ({
                                value: item.id,
                                label: `${item.name} (${item.id})`,
                              }))}
                              onChange={(modelId) => {
                                const levels = fallbackModels.find((item) => item.id === modelId)
                                  ?.reasoningLevels ?? ['off']
                                changeFallback({
                                  ...fallback,
                                  modelId,
                                  reasoning: levels.includes(fallback.reasoning)
                                    ? fallback.reasoning
                                    : levels[0]!,
                                })
                              }}
                            />
                            <Choice
                              label={`${DEPTH_LABELS[key]} · 过载备用推理强度`}
                              visibleLabel="备用推理强度"
                              value={fallback.reasoning || '__unset__'}
                              options={(fallbackSelected?.reasoningLevels ?? []).map((level) => ({
                                value: level,
                                label: EFFORT_LABELS[level],
                              }))}
                              onChange={(reasoning) =>
                                changeFallback({
                                  ...fallback,
                                  reasoning: reasoning as ModelReasoningLevel,
                                })
                              }
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-muted-foreground">
                            过载备用
                          </span>
                          <div className="w-40">
                            <Choice
                              label={`${DEPTH_LABELS[key]} · 过载备用 Provider`}
                              visibleLabel=""
                              compact
                              value="__none__"
                              options={[
                                { value: '__none__', label: '不切换' },
                                ...settings.providers.map((item) => ({
                                  value: item.id,
                                  label: item.name || item.id,
                                })),
                              ]}
                              onChange={(providerId) => {
                                if (providerId === '__none__') return
                                changeFallback({ providerId, modelId: '', reasoning: 'off' })
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Agent Provider 实例</h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                let n = 1
                while (settings.providers.some((provider) => provider.id === `provider-${n}`)) n++
                updateSettings((current) => ({
                  ...current,
                  providers: [
                    ...current.providers,
                    {
                      id: `provider-${n}`,
                      name: `Provider ${n}`,
                      template: 'openai',
                      baseUrl: '',
                      secretRef: 'OPENAI_API_KEY',
                      models: [],
                    },
                  ],
                }))
              }}
            >
              <Plus className="size-3.5" />
              添加 Provider
            </Button>
          </div>

          <div className="space-y-3">
            {settings.providers.map((provider, index) => (
              <ProviderEditor
                key={provider.id}
                provider={provider}
                templates={initial.templates}
                credentialReady={initial.credentialReady[provider.id]}
                onChange={(next) => updateProvider(index, next)}
                onRemove={() => {
                  setProbeResults({})
                  updateSettings((current) => ({
                    ...current,
                    providers: current.providers.filter((_, i) => i !== index),
                  }))
                }}
                inUse={Object.values(settings.profiles).some(
                  (profile) =>
                    profile.providerId === provider.id ||
                    profile.fallback?.providerId === provider.id,
                )}
              />
            ))}
          </div>
        </section>
      </fieldset>
    </form>
  )
}

function ProviderEditor({
  provider,
  templates,
  credentialReady,
  onChange,
  onRemove,
  inUse,
}: {
  provider: AgentProviderSettings
  templates: AgentModelSettingsView['templates']
  credentialReady?: boolean
  onChange: (next: AgentProviderSettings) => void
  onRemove: () => void
  inUse: boolean
}) {
  const template = templates.find((item) => item.id === provider.template)
  const [modelsOpen, setModelsOpen] = useState(
    () => provider.models.length > 0 || provider.template === 'custom',
  )
  const [expandedModels, setExpandedModels] = useState<Record<number, boolean>>({})
  const [confirmRemove, setConfirmRemove] = useState(false)

  function toggleModelExpanded(index: number) {
    setExpandedModels((current) => ({ ...current, [index]: !current[index] }))
  }

  function removeExpandedModel(removedIndex: number) {
    setExpandedModels((current) => {
      const next: Record<number, boolean> = {}
      for (const [rawKey, isOpen] of Object.entries(current)) {
        const key = Number(rawKey)
        if (!isOpen || key === removedIndex) continue
        next[key > removedIndex ? key - 1 : key] = true
      }
      return next
    })
  }

  return (
    <div className="space-y-3 rounded-xl border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{provider.name}</h3>
          <span className="font-mono text-xs text-muted-foreground">{provider.id}</span>
          {inUse ? <Badge variant="secondary">路由使用中</Badge> : null}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                'size-2 rounded-full',
                credentialReady === undefined
                  ? 'bg-muted-foreground/40'
                  : credentialReady
                    ? 'bg-success'
                    : 'bg-warning',
              )}
              aria-hidden
            />
            {credentialReady === undefined
              ? '待核验凭证'
              : credentialReady
                ? '凭证已配置'
                : '缺密钥'}
          </span>
        </div>
        {confirmRemove && !inUse ? (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="destructive"
              size="xs"
              onClick={() => {
                setConfirmRemove(false)
                onRemove()
              }}
            >
              确认删除
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmRemove(false)}>
              取消
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={inUse}
            onClick={() => setConfirmRemove(true)}
            aria-label={`删除 ${provider.name}`}
            title={inUse ? '先将使用此 Provider 的档位改到其他 Provider' : undefined}
          >
            <Trash2 className="size-3.5" />
            删除
          </Button>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label={`${provider.id} · 名称`}
          visibleLabel="显示名称"
          value={provider.name}
          onChange={(name) => onChange({ ...provider, name })}
        />
        <Choice
          label={`${provider.id} · Pi Provider`}
          visibleLabel="厂商模板"
          value={provider.template}
          options={templates.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(value) => {
            if (value === 'custom') setModelsOpen(true)
            onChange({ ...provider, template: value })
          }}
        />
        <Field
          label={`${provider.id} · API 地址（留空使用厂商默认）`}
          visibleLabel={`API 地址${template?.baseUrl ? `（默认 ${template.baseUrl}）` : ''}`}
          value={provider.baseUrl}
          mono
          placeholder={template?.baseUrl || 'https://api.example.com/v1'}
          onChange={(baseUrl) => onChange({ ...provider, baseUrl })}
        />
        <div className="space-y-1.5">
          <Field
            label={`${provider.id} · 密钥环境变量名`}
            visibleLabel="密钥环境变量名"
            value={provider.secretRef}
            mono
            placeholder={
              provider.id === 'upstream-gateway'
                ? '留空沿用网关默认凭证'
                : 'OPENAI_API_KEY 或 AGENT_PROVIDER_XXX_API_KEY'
            }
            onChange={(secretRef) => onChange({ ...provider, secretRef })}
          />
          <div className="flex flex-wrap gap-1">
            {AGENT_PROVIDER_SECRET_REFS.slice(0, 6).map((refName) => {
              const selected = provider.secretRef === refName
              return (
                <button
                  key={refName}
                  type="button"
                  onClick={() => onChange({ ...provider, secretRef: refName })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors',
                    selected
                      ? 'border-primary/50 bg-secondary font-medium text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {selected ? <Check className="size-3 text-success" /> : null}
                  {refName}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/25 px-3 py-2">
          <button
            type="button"
            onClick={() => setModelsOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 text-left text-xs font-medium text-foreground"
          >
            {modelsOpen ? (
              <ChevronDown className="size-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 text-muted-foreground" />
            )}
            <span>自定义模型与目录覆盖（{provider.models.length}）</span>
          </button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              const nextIndex = provider.models.length
              setModelsOpen(true)
              setExpandedModels((current) => ({ ...current, [nextIndex]: true }))
              onChange({
                ...provider,
                models: [
                  ...provider.models,
                  {
                    id: '',
                    name: '',
                    api: 'openai-completions',
                    contextWindow: 128000,
                    maxTokens: 16000,
                    imageInput: true,
                    reasoningLevels: ['off'],
                  },
                ],
              })
            }}
          >
            <Plus className="size-3" />
            添加自定义模型
          </Button>
        </div>

        {modelsOpen ? (
          <div className="divide-y border-t">
            {provider.models.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                内置目录模型可直接在上方档位中选择，按需添加自定义覆盖。
              </p>
            ) : (
              provider.models.map((model, index) => {
                const expanded = Boolean(expandedModels[index])
                return (
                  <div key={`${index}-${provider.id}`} className="bg-background">
                    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleModelExpanded(index)}
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 text-left"
                      >
                        {expanded ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate text-xs font-medium text-foreground">
                          {model.name || model.id || `模型 ${index + 1}`}
                        </span>
                        {model.id ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {model.id}
                          </span>
                        ) : (
                          <Badge variant="warning" className="px-1.5 py-0 text-[11px]">
                            待填 ID
                          </Badge>
                        )}
                        <Badge variant="outline" className="px-1.5 py-0 font-mono text-[11px]">
                          {model.api}
                        </Badge>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatCompactTokens(model.contextWindow)} ctx ·{' '}
                          {formatCompactTokens(model.maxTokens)} out
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {model.imageInput ? '视觉' : '仅文本'} · {model.reasoningLevels.length}{' '}
                          档推理
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => toggleModelExpanded(index)}
                        >
                          {expanded ? '收起' : '编辑'}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => {
                            removeExpandedModel(index)
                            onChange({
                              ...provider,
                              models: provider.models.filter((_, i) => i !== index),
                            })
                          }}
                          aria-label={`删除 ${provider.id} 模型 ${index + 1}`}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>

                    {expanded ? (
                      <div className="border-t bg-muted/20 p-3">
                        <ModelEditor
                          model={model}
                          label={`${provider.id} 模型 ${index + 1}`}
                          onChange={(next) =>
                            onChange({
                              ...provider,
                              models: provider.models.map((item, i) => (i === index ? next : item)),
                            })
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ModelEditor({
  model,
  label,
  onChange,
}: {
  model: AgentConfiguredModel
  label: string
  onChange: (next: AgentConfiguredModel) => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <Field
          label={`${label} · 模型 ID`}
          visibleLabel="模型 ID"
          value={model.id}
          mono
          placeholder="gpt-5 / claude-sonnet-4-5"
          onChange={(id) => onChange({ ...model, id })}
        />
        <Field
          label={`${label} · 显示名称`}
          visibleLabel="显示名称"
          value={model.name}
          placeholder="模型展示名"
          onChange={(name) => onChange({ ...model, name })}
        />
        <Choice
          label={`${label} · API 协议`}
          visibleLabel="API 协议"
          value={model.api}
          options={AGENT_PROVIDER_APIS.map((api) => ({ value: api, label: api }))}
          onChange={(api) => onChange({ ...model, api: api as AgentConfiguredModel['api'] })}
        />
        <Field
          label={`${label} · 上下文窗口`}
          visibleLabel="上下文窗口（tokens）"
          type="number"
          mono
          value={model.contextWindow}
          onChange={(value) => onChange({ ...model, contextWindow: Number(value) })}
        />
        <Field
          label={`${label} · 输出 token 上限`}
          visibleLabel="最大输出（tokens）"
          type="number"
          mono
          value={model.maxTokens}
          onChange={(value) => onChange({ ...model, maxTokens: Number(value) })}
        />
        <div className="flex items-end pb-1">
          <div className="flex items-center gap-2.5">
            <Switch
              id={`${label}-vision`}
              checked={model.imageInput}
              onCheckedChange={(checked) => onChange({ ...model, imageInput: checked })}
            />
            <label htmlFor={`${label}-vision`} className="cursor-pointer text-xs font-medium">
              支持图片输入
            </label>
          </div>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
          支持的推理强度档位
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {MODEL_REASONING_LEVELS.map((level) => {
            const checked = model.reasoningLevels.includes(level)
            return (
              <label
                key={level}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                  checked
                    ? 'border-primary/50 bg-secondary font-medium text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  aria-label={`${label} 支持 ${level}`}
                  checked={checked}
                  onChange={(event) =>
                    onChange({
                      ...model,
                      reasoningLevels: event.target.checked
                        ? [...model.reasoningLevels, level]
                        : model.reasoningLevels.filter((item) => item !== level),
                    })
                  }
                />
                {checked ? <Check className="size-3 text-success" /> : null}
                <span>{EFFORT_LABELS[level]}</span>
              </label>
            )
          })}
        </div>
      </fieldset>
    </div>
  )
}
