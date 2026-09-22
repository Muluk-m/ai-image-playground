import { PROMPT_REWRITE_GUARD_PREFIX } from '@image-playground/shared'
import { useStore } from '../store'
import type { InputImage, TaskParams, TaskRecord } from '../types'
import { createBuiltinEdgeProfile, normalizeSettings } from './apiProfiles'
import { scopedStorageName } from './authScope'
import { getPublicChannels } from './channels/publicChannels'
import { resolveMediaSource } from './cloudMedia'
import { BASE_DB_NAME, hashDataUrl, openNamedDb } from './db'

/**
 * 复用一条平台记录所需的全部东西。作品页的卡片已经带着它们（见 `lib/cloudMirror`），
 * 所以复用不再先读一次详情——提示词、参数和模型都已经画在用户眼前了，为它们多等一个来回说不过去。
 */
export interface CloudReuseSource {
  provider: string
  model: string
  prompt: string
  params: TaskParams
  /** `aip-media:` 引用，像素仍在平台上。 */
  inputs: readonly string[]
  mask: string | null
}

/** 镜像卡自己就是投影，够不够复用只看 provider 在不在：早先版本镜下来的卡没有它。 */
export function cloudReuseSourceFromTask(task: TaskRecord): CloudReuseSource | null {
  if (!task.cloudProvider || !task.apiModel) return null
  return {
    provider: task.cloudProvider,
    model: task.apiModel,
    prompt: task.prompt,
    params: task.params,
    inputs: task.inputImageIds,
    mask: task.maskImageId ?? null,
  }
}

/** Prepare everything before replacing the draft; never submit a generation from history reuse. */
export async function reuseCloudGeneration(source: CloudReuseSource, signal: AbortSignal) {
  const scope = scopedStorageName(BASE_DB_NAME)
  const current = () => {
    signal.throwIfAborted()
    if (scope !== scopedStorageName(BASE_DB_NAME)) throw new Error('scope_changed')
  }
  const channel = getPublicChannels().find(
    (entry) =>
      entry.kind === (source.provider === 'gemini' ? 'gemini-queue' : 'openai-queue') &&
      entry.models.some((model) => model.id === source.model),
  )
  if (!channel) throw new Error('model_unavailable')
  const guard = `${PROMPT_REWRITE_GUARD_PREFIX}\n`
  const guarded = source.prompt.startsWith(guard)
  const params: TaskParams = { ...source.params, no_rewrite: guarded }
  // Each reference has its own signed URL and download. Restore them concurrently;
  // preserve the recorded order, and only replace the draft once every image is ready.
  // 用户站在那儿等，所以这几张插队到作品页正在铺的预览之前。
  const [inputs, maskDataUrl] = await Promise.all([
    Promise.all(
      source.inputs.map(async (reference): Promise<InputImage> => {
        const dataUrl = await resolveMediaSource(reference, 'original', true)
        current()
        return { id: await hashDataUrl(dataUrl), dataUrl }
      }),
    ),
    source.mask ? resolveMediaSource(source.mask, 'original', true) : null,
  ])
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
    ) ?? createBuiltinEdgeProfile(channel.id, source.model)
  state.setSettings({
    profiles: settings.profiles.map((item) =>
      item.id === profile.id ? { ...profile, selectedModelId: source.model } : item,
    ),
    activeProfileId: profile.id,
  })
  state.setReusedTaskApiProfile(null)
  state.setParams(params)
  state.setInputImages(inputs)
  state.setMaskDraft(
    maskDataUrl ? { targetImageId: inputs[0]!.id, maskDataUrl, updatedAt: Date.now() } : null,
  )
  state.setPrompt(guarded ? source.prompt.slice(guard.length) : source.prompt)
  // 复用参数是生图入口的输入框在接：切到生图，画布的草稿另算。
  state.setAppMode('image')
}
