import { ChipIcons } from './chipIcons'

const COMPACT_MODEL_NAMES: Readonly<Record<string, string>> = {
  'gpt-image-2': 'Image 2',
  'gpt-image-2.5-flare': 'Image 2.5 Flare',
  'gpt-image-2.5-sunburst': 'Image 2.5 Sunburst',
  'gemini-3.1-flash-image': 'Gemini 3.1 Flash',
  'gemini-3.1-flash-image-preview': 'Gemini 3.1 Preview',
  'gemini-2.5-flash-image': 'Gemini 2.5 Flash',
  'agnes-image-2.1-flash': 'Agnes 2.1 Flash',
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

export function ModelLogo({ model }: { model: string }) {
  const brand = model.startsWith('gpt-image-')
    ? 'openai'
    : model.startsWith('gemini-')
      ? 'gemini'
      : model.startsWith('grok-')
        ? 'grok'
        : model.startsWith('agnes-')
          ? 'agnes'
          : null

  if (!brand) return ChipIcons.model

  return (
    <img
      src={`/model-logos/${brand}.${brand === 'agnes' ? 'png' : 'svg'}`}
      alt=""
      aria-hidden="true"
      width={16}
      height={16}
      className={`h-4 w-4 shrink-0 object-contain ${
        brand === 'agnes' ? 'invert dark:invert-0' : brand === 'gemini' ? '' : 'dark:invert'
      }`}
    />
  )
}
