import {
  AGENT_PROFILE_KEYS,
  AGENT_PROVIDER_APIS,
  AGENT_PROVIDER_SECRET_REFS,
  type AgentConfiguredModel,
  type AgentModelSettings,
  type AgentModelSettingsView,
  type AgentProfileKey,
  type AgentProviderSettings,
  MODEL_REASONING_LEVELS,
  type ModelReasoningLevel,
} from '@image-playground/shared'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const DEPTH_LABELS: Record<AgentProfileKey, string> = {
  default: '默认',
  fast: '快速',
  medium: '普通',
  deep: '深度',
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

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
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
  value,
  onChange,
  type = 'text',
  disabled = false,
}: {
  label: string
  value: string | number
  onChange: (value: string) => void
  type?: string
  disabled?: boolean
}) {
  return (
    <label className="block space-y-1 text-xs text-muted-foreground">
      {label}
      <Input
        aria-label={label}
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

export function AgentModelSettingsForm({
  initial,
  save,
  pending,
  error,
}: {
  initial: AgentModelSettingsView
  save: (settings: AgentModelSettings, revision: number) => Promise<AgentModelSettingsView | void>
  pending: boolean
  error: string | null
}) {
  const [baseline, setBaseline] = useState(initial)
  const [settings, setSettings] = useState(() => structuredClone(initial.settings))
  const dirty = JSON.stringify(settings) !== JSON.stringify(baseline.settings)
  function updateProvider(index: number, next: AgentProviderSettings) {
    setSettings((current) => ({
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
  const invalidProfiles = AGENT_PROFILE_KEYS.filter((key) => {
    const profile = settings.profiles[key]
    const provider = settings.providers.find((item) => item.id === profile.providerId)
    const model = modelsFor(provider).find((item) => item.id === profile.modelId)
    return !model || !model.reasoningLevels.includes(profile.reasoning)
  })
  function discard() {
    setBaseline(initial)
    setSettings(structuredClone(initial.settings))
  }
  async function submit() {
    if (invalidProfiles.length) return
    const saved = await save(settings, baseline.revision)
    if (saved) {
      setBaseline(saved)
      setSettings(structuredClone(saved.settings))
    }
  }
  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <fieldset disabled={pending} className="space-y-6">
        {initial.validationError ? (
          <p role="alert" className="text-sm text-destructive">
            {initial.validationError}
          </p>
        ) : null}
        {initial.revision !== baseline.revision ? (
          <p role="status" className="text-sm text-destructive">
            服务器配置已有新版本，当前草稿已保留。请先放弃修改并载入新配置，再重新编辑。
          </p>
        ) : null}
        {invalidProfiles.length ? (
          <p role="alert" className="text-sm text-destructive">
            请重新选择以下档位的模型和推理强度：
            {invalidProfiles.map((key) => DEPTH_LABELS[key]).join('、')}。模型必须支持图片输入。
          </p>
        ) : null}
        <section className="space-y-4 rounded-lg border p-4">
          <div>
            <h2 className="font-semibold">产品档位</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              用户选择快速、普通或深度；每档分别决定接入哪个模型，以及该模型使用多大推理强度。同一个模型可以用于多个档位。
            </p>
          </div>
          {AGENT_PROFILE_KEYS.map((key) => {
            const profile = settings.profiles[key]
            const provider = settings.providers.find((item) => item.id === profile.providerId)
            const models = modelsFor(provider)
            const selected = models.find((model) => model.id === profile.modelId)
            function change(next: Partial<typeof profile>) {
              setSettings((current) => ({
                ...current,
                profiles: { ...current.profiles, [key]: { ...profile, ...next } },
              }))
            }
            return (
              <div
                key={key}
                className="grid items-end gap-3 rounded-md bg-muted/30 p-3 md:grid-cols-[6rem_1fr_1.5fr_1fr]"
              >
                <div className="pb-2 text-sm font-medium">
                  {DEPTH_LABELS[key]}
                  {key === 'default' ? (
                    <p className="mt-1 text-xs font-normal text-muted-foreground">未指定档位时</p>
                  ) : null}
                </div>
                <Choice
                  label={`${DEPTH_LABELS[key]} · Provider`}
                  value={profile.providerId}
                  options={settings.providers.map((item) => ({
                    value: item.id,
                    label: item.name || item.id,
                  }))}
                  onChange={(providerId) => change({ providerId, modelId: '', reasoning: 'off' })}
                />
                <Choice
                  label={`${DEPTH_LABELS[key]} · 模型`}
                  value={profile.modelId}
                  options={models.map((item) => ({
                    value: item.id,
                    label: `${item.name} (${item.id})`,
                  }))}
                  onChange={(modelId) => {
                    const levels = models.find((item) => item.id === modelId)?.reasoningLevels ?? [
                      'off',
                    ]
                    change({
                      modelId,
                      reasoning: levels.includes(profile.reasoning) ? profile.reasoning : levels[0],
                    })
                  }}
                />
                <Choice
                  label={`${DEPTH_LABELS[key]} · 模型推理强度`}
                  value={profile.reasoning}
                  options={(selected?.reasoningLevels ?? []).map((level) => ({
                    value: level,
                    label: EFFORT_LABELS[level],
                  }))}
                  onChange={(reasoning) => change({ reasoning: reasoning as ModelReasoningLevel })}
                />
              </div>
            )
          })}
        </section>
        <section className="space-y-4">
          <div>
            <h2 className="font-semibold">Provider 接入</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              从 Pi 厂商目录选择模型，或添加自定义 API
              与模型。仅显示支持图片输入的模型，确保视觉工具可用。密钥使用专用环境变量名，真实密钥由部署环境管理。
              支持的密钥引用：{AGENT_PROVIDER_SECRET_REFS.join('、')}，或
              AGENT_PROVIDER_名称_API_KEY。
            </p>
          </div>
          {settings.providers.map((provider, index) => (
            <ProviderEditor
              key={provider.id}
              provider={provider}
              templates={initial.templates}
              credentialReady={initial.credentialReady[provider.id]}
              onChange={(next) => updateProvider(index, next)}
              onRemove={() =>
                setSettings((current) => ({
                  ...current,
                  providers: current.providers.filter((_, i) => i !== index),
                }))
              }
              inUse={Object.values(settings.profiles).some(
                (profile) => profile.providerId === provider.id,
              )}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              let n = 1
              while (settings.providers.some((provider) => provider.id === `provider-${n}`)) n++
              setSettings((current) => ({
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
            <Plus className="mr-2 size-4" />
            添加 Provider
          </Button>
        </section>
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/50 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Button
            type="submit"
            disabled={
              (!dirty && !initial.validationError) ||
              pending ||
              invalidProfiles.length > 0 ||
              initial.revision !== baseline.revision
            }
          >
            <Save className="mr-2 size-4" />
            {pending ? '保存中…' : '保存配置'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={(!dirty && initial.revision === baseline.revision) || pending}
            onClick={discard}
          >
            放弃修改
          </Button>
          <p className="text-xs text-muted-foreground">
            保存后从下一轮对话生效，进行中的对话轮保持原配置。模型积分价格在计费设置中单独管理。
          </p>
        </div>
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
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">
          {provider.name} <span className="text-xs text-muted-foreground">{provider.id}</span>
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={inUse}
          onClick={onRemove}
          aria-label={`删除 ${provider.name}`}
          title={inUse ? '先将使用此 Provider 的档位改到其他 Provider' : undefined}
        >
          <Trash2 className="mr-1 size-4" />
          删除
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label={`${provider.id} · 名称`}
          value={provider.name}
          onChange={(name) => onChange({ ...provider, name })}
        />
        <Choice
          label={`${provider.id} · Pi Provider`}
          value={provider.template}
          options={templates.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(value) => onChange({ ...provider, template: value })}
        />
        <Field
          label={`${provider.id} · API 地址（留空使用厂商默认）`}
          value={provider.baseUrl}
          onChange={(baseUrl) => onChange({ ...provider, baseUrl })}
        />
        <Field
          label={`${provider.id} · 密钥环境变量名`}
          value={provider.secretRef}
          onChange={(secretRef) => onChange({ ...provider, secretRef })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {template?.baseUrl ? `厂商默认地址：${template.baseUrl}。` : ''}已保存凭证状态：
        {credentialReady === undefined ? '尚未保存' : credentialReady ? '已配置' : '未配置'}。
        {provider.id === 'upstream-gateway' ? '密钥引用留空且地址不变时沿用现有网关凭证。' : ''}
      </p>
      <details
        className="rounded-md border p-3"
        open={provider.models.length > 0 || provider.template === 'custom'}
      >
        <summary className="cursor-pointer text-sm font-medium">
          自定义模型与目录覆盖（{provider.models.length}）
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          厂商模型可直接在上方选择。仅在目录缺少模型或需要调整窗口等参数时添加；相同模型 ID
          会覆盖目录条目。
        </p>
        <div className="mt-3 space-y-4">
          {provider.models.map((model, index) => (
            <ModelEditor
              key={`${index}-${provider.id}`}
              model={model}
              label={`${provider.id} 模型 ${index + 1}`}
              onChange={(next) =>
                onChange({
                  ...provider,
                  models: provider.models.map((item, i) => (i === index ? next : item)),
                })
              }
              onRemove={() =>
                onChange({ ...provider, models: provider.models.filter((_, i) => i !== index) })
              }
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
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
            }
          >
            <Plus className="mr-1 size-4" />
            添加自定义模型
          </Button>
        </div>
      </details>
    </section>
  )
}

function ModelEditor({
  model,
  label,
  onChange,
  onRemove,
}: {
  model: AgentConfiguredModel
  label: string
  onChange: (next: AgentConfiguredModel) => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-3 rounded-md bg-muted/30 p-3">
      <div className="grid gap-3 md:grid-cols-3">
        <Field
          label={`${label} · 模型 ID`}
          value={model.id}
          onChange={(id) => onChange({ ...model, id })}
        />
        <Field
          label={`${label} · 显示名称`}
          value={model.name}
          onChange={(name) => onChange({ ...model, name })}
        />
        <Choice
          label={`${label} · API 协议`}
          value={model.api}
          options={AGENT_PROVIDER_APIS.map((api) => ({ value: api, label: api }))}
          onChange={(api) => onChange({ ...model, api: api as AgentConfiguredModel['api'] })}
        />
        <Field
          label={`${label} · 上下文窗口`}
          type="number"
          value={model.contextWindow}
          onChange={(value) => onChange({ ...model, contextWindow: Number(value) })}
        />
        <Field
          label={`${label} · 输出 token 上限`}
          type="number"
          value={model.maxTokens}
          onChange={(value) => onChange({ ...model, maxTokens: Number(value) })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={model.imageInput}
            onChange={(event) => onChange({ ...model, imageInput: event.target.checked })}
          />
          支持图片输入
        </label>
      </div>
      <fieldset>
        <legend className="mb-2 text-xs text-muted-foreground">
          模型支持的推理强度（按厂商实际能力填写）
        </legend>
        <div className="flex flex-wrap gap-3">
          {MODEL_REASONING_LEVELS.map((level) => (
            <label key={level} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                aria-label={`${label} 支持 ${level}`}
                checked={model.reasoningLevels.includes(level)}
                onChange={(event) =>
                  onChange({
                    ...model,
                    reasoningLevels: event.target.checked
                      ? [...model.reasoningLevels, level]
                      : model.reasoningLevels.filter((item) => item !== level),
                  })
                }
              />
              {EFFORT_LABELS[level]}
            </label>
          ))}
        </div>
      </fieldset>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRemove}
        aria-label={`删除 ${label}`}
      >
        <Trash2 className="mr-1 size-4" />
        删除模型
      </Button>
    </div>
  )
}
