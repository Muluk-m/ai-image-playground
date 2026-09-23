import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { DEFAULT_IMAGES_MODEL } from '../../lib/apiProfiles'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../lib/clipboard'
import { profileSeedNames } from '../../lib/profileSeedNames'
import { useStore } from '../../store'
import type { CustomProviderDefinition } from '../../types'
import { CloseIcon, LinkIcon } from '../icons'
import Overlay from '../Overlay'
import ViewportTooltip from '../ViewportTooltip'

export interface CustomProviderForm {
  json: string
}

const DEFAULT_CUSTOM_PROVIDER_MANIFEST = {
  submit: {
    path: 'images/generations',
    method: 'POST',
    contentType: 'json',
    body: {
      model: '$profile.model',
      prompt: '$prompt',
      size: '$params.size',
      quality: '$params.quality',
      output_format: '$params.output_format',
      moderation: '$params.moderation',
      output_compression: '$params.output_compression',
      n: '$params.n',
    },
    result: {
      imageUrlPaths: ['data.*.url'],
      b64JsonPaths: ['data.*.b64_json'],
    },
  },
  editSubmit: {
    path: 'images/edits',
    method: 'POST',
    contentType: 'multipart',
    body: {
      model: '$profile.model',
      prompt: '$prompt',
      size: '$params.size',
      quality: '$params.quality',
      output_format: '$params.output_format',
      moderation: '$params.moderation',
      output_compression: '$params.output_compression',
      n: '$params.n',
    },
    files: [
      { field: 'image[]', source: 'inputImages', array: true },
      { field: 'mask', source: 'mask' },
    ],
    result: {
      imageUrlPaths: ['data.*.url'],
      b64JsonPaths: ['data.*.b64_json'],
    },
  },
}

export function createDefaultCustomProviderForm(): CustomProviderForm {
  return {
    // 名字是初值文案：打开表单这一刻的界面语言，所以不能跟着模块级常量一起定死。
    json: JSON.stringify(
      { name: profileSeedNames().customProvider, ...DEFAULT_CUSTOM_PROVIDER_MANIFEST },
      null,
      2,
    ),
  }
}

export function customProviderToForm(provider: CustomProviderDefinition): CustomProviderForm {
  return {
    json: JSON.stringify(
      {
        name: provider.name,
        submit: provider.submit,
        editSubmit: provider.editSubmit,
        poll: provider.poll,
      },
      null,
      2,
    ),
  }
}

export function customProviderFormToInput(form: CustomProviderForm) {
  return JSON.parse(form.json)
}

const CUSTOM_PROVIDER_LLM_PROMPT = `# 角色
你是 API 文档解析助手。你的任务是根据用户提供的图像生成 API 文档，生成本应用可导入的自定义服务商配置 JSON。

# 工作流程
1. 先向用户索要 API 文档链接或完整文档文本。
2. 如果当前环境支持读取链接，主动读取；否则要求用户粘贴文档内容。
3. 在未获得文档前不要猜测，不要生成占位配置。
4. 从文档中判断提交接口、图生图接口、异步任务查询接口、状态值、结果图片路径。
5. 如果文档中明确了默认模型 ID 或 API Base URL，在 profiles 中填入；如果未明确模型 ID，model 使用 "${DEFAULT_IMAGES_MODEL}"；如果未明确 API Base URL，baseUrl 留空，由用户稍后填写。
6. 输出最终 JSON；不要索要 API Key。

# 输出结构
输出 JSON 包含两个顶层字段：
- customProviders：自定义服务商 Manifest 数组，每项描述一个服务商的接口映射规则。
- profiles：API 配置数组，每项描述一个可直接使用的连接配置，引用 customProviders 中的服务商。

## customProviders 元素（Manifest）
每个元素的顶层字段：id、name、submit、editSubmit、poll。
id 是服务商的唯一标识，用于 profiles 中的 provider 字段引用，建议使用 custom-{英文短名} 格式。
submit 是文生图提交配置，必填。
editSubmit 是图生图或局部重绘提交配置，可选。如果文生图和图生图使用同一个 JSON 接口，可以省略 editSubmit，并在 submit.body 中加入 image_urls。
poll 是异步任务查询配置，可选；同步接口不要写 poll。

submit/editSubmit 字段：
- path：接口路径，不带开头斜杠，不带 /v1/ 前缀，例如 images/generations 或 tasks/{task_id}。
- method：GET 或 POST，默认 POST。
- contentType：json 或 multipart。
- query：提交 query 参数对象，可选，例如 {"async":"true"}。
- body：请求体模板对象。
- files：multipart 文件字段数组，仅 contentType=multipart 时使用。
- taskIdPath：提交响应里的任务 ID JSON 路径；同步接口不要写。
- result：同步响应图片提取规则。

poll 字段：
- path：任务查询路径，使用 {task_id} 占位，例如 images/tasks/{task_id} 或 tasks/{task_id}。
- method：GET 或 POST，默认 GET。
- query：查询 query 参数对象，可选。
- intervalSeconds：轮询间隔秒数。
- statusPath：查询响应状态字段路径。
- successValues：成功状态值数组。
- failureValues：失败状态值数组。
- errorPath：失败原因路径，可选。
- result：成功后图片提取规则。

result 字段：
- imageUrlPaths：图片 URL 路径数组，支持 * 通配数组。例如 data.*.url、data.result.images.*.url.*。
- b64JsonPaths：base64 图片路径数组，支持 * 通配数组。例如 data.*.b64_json。

body 模板变量：
- $profile.model：用户在设置里填写的模型 ID。
- $prompt：当前提示词。
- $params.size、$params.quality、$params.output_format、$params.output_compression、$params.moderation、$params.n：应用内参数。
- $inputImages.dataUrls：参考图 data URL 数组；没有参考图时会自动省略该字段。
- $mask.dataUrl：遮罩图 data URL；没有遮罩时会自动省略该字段。

multipart files 示例：
- {"field":"image[]","source":"inputImages","array":true}
- {"field":"mask","source":"mask"}

## profiles 元素
每个元素的字段：
- name：配置名称，方便用户识别。
- provider：对应 customProviders 中某个元素的 id。
- baseUrl：API Base URL。如果文档明确给出，填入完整基础地址；否则留空字符串 ""。
- model：模型 ID。如果 API 文档明确了默认模型，填入该值；否则使用 "${DEFAULT_IMAGES_MODEL}"。
- apiMode：固定为 "images"。

profiles 中不要包含 apiKey（用户导入后自行填写）。

# 输出要求
- 最终回复只包含一个 \`\`\`json 代码块，代码块内是 JSON 对象。
- JSON 对象必须包含 customProviders 和 profiles 两个顶层字段。
- 代码块外不要附加解释文字。
- 不要输出 API Key、Authorization header。
- 如果文档返回 task_id，就必须配置 taskIdPath 和 poll。
- 如果结果 URL 是数组，路径必须写到数组元素，例如 data.result.images.*.url.*。

## 同步接口示例
{"customProviders":[{"id":"custom-example-sync","name":"示例同步服务商","submit":{"path":"images/generations","method":"POST","contentType":"json","body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","quality":"$params.quality","output_format":"$params.output_format","moderation":"$params.moderation","output_compression":"$params.output_compression","n":"$params.n"},"result":{"imageUrlPaths":["data.*.url"],"b64JsonPaths":["data.*.b64_json"]}},"editSubmit":{"path":"images/edits","method":"POST","contentType":"multipart","body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","quality":"$params.quality","output_format":"$params.output_format","moderation":"$params.moderation","output_compression":"$params.output_compression","n":"$params.n"},"files":[{"field":"image[]","source":"inputImages","array":true},{"field":"mask","source":"mask"}],"result":{"imageUrlPaths":["data.*.url"],"b64JsonPaths":["data.*.b64_json"]}}}],"profiles":[{"name":"示例同步服务商","provider":"custom-example-sync","baseUrl":"https://api.example.com/v1","model":"example-model-v1","apiMode":"images"}]}

## 异步接口示例
{"customProviders":[{"id":"custom-example-async","name":"示例异步服务商","submit":{"path":"images/generations","method":"POST","contentType":"json","query":{"async":"true"},"body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","n":"$params.n"},"taskIdPath":"data"},"editSubmit":{"path":"images/edits","method":"POST","contentType":"multipart","query":{"async":"true"},"body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","n":"$params.n"},"files":[{"field":"image[]","source":"inputImages","array":true}],"taskIdPath":"data"},"poll":{"path":"images/tasks/{task_id}","method":"GET","intervalSeconds":5,"statusPath":"data.status","successValues":["SUCCESS"],"failureValues":["FAILURE"],"errorPath":"data.fail_reason","result":{"imageUrlPaths":["data.data.data.*.url"],"b64JsonPaths":["data.data.data.*.b64_json"]}}}],"profiles":[{"name":"示例异步服务商","provider":"custom-example-async","baseUrl":"","model":"${DEFAULT_IMAGES_MODEL}","apiMode":"images"}]}

## 统一任务接口示例
{"customProviders":[{"id":"custom-example-task","name":"示例任务服务商","submit":{"path":"images/generations","method":"POST","contentType":"json","body":{"model":"$profile.model","prompt":"$prompt","n":"$params.n","size":"$params.size","resolution":"2k","quality":"$params.quality","image_urls":"$inputImages.dataUrls"},"taskIdPath":"data.0.task_id"},"poll":{"path":"tasks/{task_id}","method":"GET","query":{"language":"zh"},"intervalSeconds":5,"statusPath":"data.status","successValues":["completed"],"failureValues":["failed","cancelled"],"errorPath":"data.error.message","result":{"imageUrlPaths":["data.result.images.*.url.*"],"b64JsonPaths":[]}}}],"profiles":[{"name":"示例任务服务商","provider":"custom-example-task","baseUrl":"","model":"${DEFAULT_IMAGES_MODEL}","apiMode":"images"}]}`

interface CustomProviderDialogProps {
  /** 编辑既有服务商（true）还是新建（false）。 */
  editing: boolean
  form: CustomProviderForm
  error: string | null
  importing: boolean
  onFormChange: (patch: Partial<CustomProviderForm>) => void
  onPasteImport: () => void
  onSave: () => void
  onClose: () => void
}

/** 自定义服务商的导入 / 编辑框。表单状态由 API 配置页持有，这里只画界面。 */
export default function CustomProviderDialog({
  editing,
  form,
  error,
  importing,
  onFormChange,
  onPasteImport,
  onSave,
  onClose,
}: CustomProviderDialogProps) {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation('common')
  const showToast = useStore((s) => s.showToast)
  const [llmPromptTooltipVisible, setLlmPromptTooltipVisible] = useState(false)
  const llmPromptTooltipTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (llmPromptTooltipTimerRef.current != null)
        window.clearTimeout(llmPromptTooltipTimerRef.current)
    },
    [],
  )

  const clearLlmPromptTooltipTimer = () => {
    if (llmPromptTooltipTimerRef.current != null) {
      window.clearTimeout(llmPromptTooltipTimerRef.current)
      llmPromptTooltipTimerRef.current = null
    }
  }

  const copyCustomProviderLlmPrompt = async () => {
    try {
      await copyTextToClipboard(CUSTOM_PROVIDER_LLM_PROMPT)
      showToast(t('toast.llmPromptCopied'), 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(t('toast.copyLlmPromptFailed'), err), 'error')
    }
  }

  return (
    <Overlay onClose={onClose} tier="raised">
      <div className="relative z-10 w-full max-w-md rounded-3xl border border-white/50 bg-card/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in border-border dark:ring-white/10 flex flex-col h-[85vh] sm:h-[680px] max-h-[90vh] overflow-hidden">
        <div className="mb-5 flex items-center justify-between gap-4 shrink-0">
          <h3 className="text-base font-bold text-foreground">
            {editing ? t('provider.editCustom') : t('provider.createCustom')}
          </h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-muted-foreground hover:bg-accent"
              aria-label={tCommon('action.close')}
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-0 px-1 -mx-1 pb-2">
          <div className="mb-6 shrink-0 rounded-2xl bg-card/80 p-4 border border-border/60 border-border">
            <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
              <svg
                className="h-4 w-4 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              {t('customProvider.aiGenerate')}
            </div>
            <div
              data-selectable-text
              className="mb-4 text-xs leading-relaxed text-muted-foreground"
            >
              {t('customProvider.aiGenerateHint')}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative inline-flex">
                <button
                  type="button"
                  onClick={copyCustomProviderLlmPrompt}
                  aria-label={t('customProvider.copyPromptAria')}
                  onMouseEnter={() => setLlmPromptTooltipVisible(true)}
                  onMouseLeave={() => setLlmPromptTooltipVisible(false)}
                  onFocus={() => setLlmPromptTooltipVisible(true)}
                  onBlur={() => setLlmPromptTooltipVisible(false)}
                  onTouchStart={() => {
                    clearLlmPromptTooltipTimer()
                    llmPromptTooltipTimerRef.current = window.setTimeout(() => {
                      setLlmPromptTooltipVisible(true)
                      llmPromptTooltipTimerRef.current = null
                    }, 450)
                  }}
                  onTouchEnd={clearLlmPromptTooltipTimer}
                  onTouchCancel={clearLlmPromptTooltipTimer}
                  className="flex items-center gap-1.5 rounded-xl bg-card px-3 py-2 text-xs font-medium text-foreground shadow-sm border border-border/80 transition hover:bg-card hover:text-foreground border-border dark:hover:text-white"
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                  {t('customProvider.copyPrompt')}
                </button>
                <ViewportTooltip
                  visible={llmPromptTooltipVisible}
                  className="w-56 whitespace-normal text-center"
                >
                  {t('customProvider.copyPromptTooltip')}
                </ViewportTooltip>
              </span>
              <button
                type="button"
                onClick={onPasteImport}
                disabled={importing}
                className="flex items-center gap-1.5 rounded-xl bg-card px-3 py-2 text-xs font-medium text-foreground shadow-sm border border-border/80 transition hover:bg-card hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed border-border dark:hover:text-white"
              >
                {importing ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    {t('data.importing')}
                  </>
                ) : (
                  t('customProvider.pasteImport')
                )}
              </button>
            </div>
          </div>

          <div className="flex-1 flex flex-col min-h-0">
            <label className="flex-1 flex flex-col min-h-0">
              <span className="mb-1 shrink-0 block text-xs text-muted-foreground">
                {t('customProvider.manualEdit')}
              </span>
              <textarea
                value={form.json}
                onChange={(e) => onFormChange({ json: e.target.value })}
                spellCheck={false}
                className="flex-1 min-h-[150px] w-full resize-none rounded-xl border border-border/70 bg-card/60 px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none transition focus:border-primary border-border custom-scrollbar"
              />
            </label>
          </div>

          {error && (
            <div
              data-selectable-text
              className="shrink-0 mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive dark:bg-destructive/10 dark:text-destructive"
            >
              {error}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-muted px-4 py-2 text-sm text-muted-foreground transition hover:bg-muted"
          >
            {tCommon('action.cancel')}
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            {editing ? t('customProvider.saveEdit') : t('customProvider.createAndUse')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
