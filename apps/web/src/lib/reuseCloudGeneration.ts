import { type GenerationDetail, PROMPT_REWRITE_GUARD_PREFIX } from '@image-playground/shared'
import { useStore } from '../store'
import {
  DEFAULT_PARAMS,
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
  type InputImage,
  type TaskParams,
} from '../types'
import { createBuiltinEdgeProfile, normalizeSettings } from './apiProfiles'
import { scopedStorageName } from './authScope'
import { getPublicChannels } from './channels/publicChannels'
import { resolveMediaSource } from './cloudMedia'
import { BASE_DB_NAME, hashDataUrl, openNamedDb } from './db'

/** Prepare everything before replacing the draft; never submit a generation from history reuse. */
export async function reuseCloudGeneration(detail: GenerationDetail, signal: AbortSignal) {
  const scope = scopedStorageName(BASE_DB_NAME)
  const current = () => {
    signal.throwIfAborted()
    if (scope !== scopedStorageName(BASE_DB_NAME)) throw new Error('scope_changed')
  }
  const channel = getPublicChannels().find(
    (entry) =>
      entry.kind === (detail.provider === 'gemini' ? 'gemini-queue' : 'openai-queue') &&
      entry.models.some((model) => model.id === detail.model),
  )
  if (!channel) throw new Error('model_unavailable')
  const p = detail.parameters
  const guard = `${PROMPT_REWRITE_GUARD_PREFIX}\n`
  const guarded = detail.prompt.startsWith(guard)
  const params: TaskParams = {
    ...DEFAULT_PARAMS,
    size: p.size ?? DEFAULT_PARAMS.size,
    quality:
      (['auto', 'low', 'medium', 'high'] as const).find((value) => value === p.quality) ??
      DEFAULT_PARAMS.quality,
    output_format:
      (['png', 'jpeg', 'webp'] as const).find((value) => value === p.output_format) ??
      DEFAULT_PARAMS.output_format,
    output_compression: p.output_compression ?? null,
    n: p.n ?? 1,
    no_rewrite: guarded,
    gemini_aspect_ratio: GEMINI_ASPECT_RATIOS.find((value) => value === p.aspect_ratio),
    gemini_image_size: GEMINI_IMAGE_SIZES.find((value) => value === p.image_size),
    gemini_thinking_level: GEMINI_THINKING_LEVELS.find((value) => value === p.thinking_level),
  }
  const inputs: InputImage[] = []
  for (const image of detail.inputs) {
    const dataUrl = await resolveMediaSource(`aip-media:${image.mediaId}`)
    current()
    inputs.push({ id: await hashDataUrl(dataUrl), dataUrl })
  }
  const maskDataUrl = detail.mask
    ? await resolveMediaSource(`aip-media:${detail.mask.mediaId}`)
    : null
  current()
  if (maskDataUrl && !inputs.length) throw new Error('input_unavailable')
  if (inputs.length) {
    const database = await openNamedDb(scope)
    try {
      current()
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('images', 'readwrite')
        const images = tx.objectStore('images')
        for (const image of inputs) {
          const existing = images.get(image.id)
          existing.onsuccess = () => {
            if (!existing.result) images.put({ ...image, source: 'upload', createdAt: Date.now() })
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      database.close()
    }
  }
  current()
  const state = useStore.getState()
  const settings = normalizeSettings(state.settings)
  const profile =
    settings.profiles.find(
      (item) => item.source === 'builtin-edge' && item.channelId === channel.id,
    ) ?? createBuiltinEdgeProfile(channel.id, detail.model)
  state.setSettings({
    profiles: settings.profiles.map((item) =>
      item.id === profile.id ? { ...profile, selectedModelId: detail.model } : item,
    ),
    activeProfileId: profile.id,
  })
  state.setReusedTaskApiProfile(null)
  state.setParams(params)
  state.setInputImages(inputs)
  state.setMaskDraft(
    maskDataUrl ? { targetImageId: inputs[0]!.id, maskDataUrl, updatedAt: Date.now() } : null,
  )
  state.setPrompt(guarded ? detail.prompt.slice(guard.length) : detail.prompt)
  // 复用参数是生图入口的输入框在接：切到生图，画布的草稿另算。
  state.setAppMode('image')
}
