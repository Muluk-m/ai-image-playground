import type { ModelLogoId } from '@image-playground/shared'
import { useSyncExternalStore } from 'react'
import { getStoredChannels, subscribeChannels } from '../lib/channels/channelStore'
import { modelLogo } from '../lib/channels/publicChannels'
import { ClaudeLogo, GeminiLogo, OpenAILogo } from './assistant-ui/elements/logos'
import { Icon } from './ui/icon'

const COMPACT_MODEL_NAMES: Readonly<Record<string, string>> = {
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-image-2': 'Image 2',
  'gpt-image-2.5-flare': 'Image 2.5 Flare',
  'gpt-image-2.5-sunburst': 'Image 2.5 Sunburst',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash',
  'gemini-3.1-flash-image-preview': 'Gemini 3.1 Preview',
  'gemini-2.5-flash-image': 'Gemini 2.5 Flash',
  'agnes-image-2.1-flash': 'Agnes 2.1 Flash',
  'agnes-image-2.5-flash': 'Agnes 2.5 Flash',
  'agnes-video-2.5-flash': 'Agnes Video 2.5',
  'grok-imagine-image': 'Grok Image 1.0',
  'grok-imagine-image-2.0': 'Grok Image 2.0',
  'grok-imagine-video': 'Grok Video',
}

/** Display only: selection and requests keep the original model ID. */
export function compactModelName(model: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(COMPACT_MODEL_NAMES, model)
    ? COMPACT_MODEL_NAMES[model]
    : fallback
}

/**
 * 模型图标。渠道配置给模型声明了自己的图标（`ChannelModel.logo`）时用它，否则按 id 前缀给厂商图标。
 *
 * - 传了 `logo`（`null` 表示确定没有声明）：调用方已从带渠道上下文的快照里取好，直接画，不订阅。
 *   模型选择器走这条：同一模型 id 在不同渠道可能声明不同图标，只有列表知道选项来自哪条渠道。
 * - 没传：按模型 id 在渠道清单里找，并订阅清单，首屏清单晚到时再换成声明的图标。
 */
export function ModelLogo({ model, logo }: { model: string; logo?: ModelLogoId | null }) {
  if (logo !== undefined) return <ResolvedModelLogo model={model} logo={logo} />
  return <CatalogModelLogo model={model} />
}

function CatalogModelLogo({ model }: { model: string }) {
  // 服务端预渲染读同一份内存清单（未加载时是空数组），与客户端首帧一致。
  const channels = useSyncExternalStore(subscribeChannels, getStoredChannels, getStoredChannels)
  return <ResolvedModelLogo model={model} logo={modelLogo(model, channels) ?? null} />
}

function ResolvedModelLogo({ model, logo }: { model: string; logo: ModelLogoId | null }) {
  // 声明的是彩色官方图标，明暗主题都不反色。
  if (logo) {
    return (
      <img
        src={`/model-logos/${logo}.svg`}
        alt=""
        aria-hidden="true"
        width={16}
        height={16}
        className="h-4 w-4 shrink-0 object-contain"
      />
    )
  }
  const brand =
    model.startsWith('gpt-') || /^o[134](?:-|$)/.test(model)
      ? 'openai'
      : model.startsWith('gemini-')
        ? 'gemini'
        : model.startsWith('grok-')
          ? 'grok'
          : model.startsWith('claude-')
            ? 'claude'
            : model.startsWith('agnes-')
              ? 'agnes'
              : null

  if (!brand) return <Icon name="model" />
  // OpenAI / Gemini 用 assistant-ui 的矢量 logo：OpenAI 跟随文字色，Gemini 保留品牌渐变。
  if (brand === 'openai') return <OpenAILogo className="h-4 w-4 shrink-0" />
  if (brand === 'gemini') return <GeminiLogo className="h-4 w-4 shrink-0" />
  if (brand === 'claude') return <ClaudeLogo className="h-4 w-4 shrink-0" />

  return (
    <img
      src={`/model-logos/${brand}.${brand === 'agnes' ? 'png' : 'svg'}`}
      alt=""
      aria-hidden="true"
      width={16}
      height={16}
      className={`h-4 w-4 shrink-0 object-contain ${
        brand === 'agnes' ? 'invert dark:invert-0' : 'dark:invert'
      }`}
    />
  )
}
