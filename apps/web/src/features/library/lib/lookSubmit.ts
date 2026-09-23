import { assembleLookRequest } from '@image-playground/shared'
import { ensureImageCached, storeImageFromFile, submitTask, useStore } from '../../../store'
import { lookImageUrl } from '../components/LookImage'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import { useActiveLook } from './activeLook'
import type { LookItem } from './looks'

/** 参考图条里出现过的素材：按首次出现的顺序，一条素材只算一次。 */
export function assetsForInputImages(
  inputImages: ReadonlyArray<{ id: string }>,
  assets: readonly AssetRecord[],
): AssetRecord[] {
  const picked: AssetRecord[] = []
  for (const image of inputImages) {
    const asset = assets.find((one) => one.views.some((view) => view.imageId === image.id))
    if (asset && !picked.includes(asset)) picked.push(asset)
  }
  return picked
}

export type LookSubmissionCheck =
  | { readonly ok: true; readonly assets: AssetRecord[] }
  | { readonly ok: false; readonly reason: 'slot_mismatch'; readonly expected: number }

/** 提交前的判定：附了几条素材、模板要几条。不够或多了都不发。 */
export function checkLookSubmission(
  look: LookItem,
  inputImages: ReadonlyArray<{ id: string }>,
  assets: readonly AssetRecord[],
): LookSubmissionCheck {
  const picked = assetsForInputImages(inputImages, assets)
  if (picked.length !== look.slotCount) {
    return { ok: false, reason: 'slot_mismatch', expected: look.slotCount }
  }
  return { ok: true, assets: picked }
}

/** 预置模板的参考图在 BFF 上：先搬进本机 image store 才能当参考图提交。 */
async function referenceImageIds(look: LookItem): Promise<string[]> {
  const ids: string[] = []
  for (const ref of look.references) {
    if (ref.kind === 'image') {
      ids.push(ref.imageId)
      continue
    }
    const response = await fetch(lookImageUrl(ref.url))
    if (!response.ok) continue
    const blob = await response.blob()
    const file = new File([blob], ref.url.split('/').pop() ?? 'reference', { type: blob.type })
    ids.push((await storeImageFromFile(file)).id)
  }
  return ids
}

/**
 * 生成模式下带着模板胶囊发送：按模板正文与素材组装提示词和参考图顺序，走普通提交。
 * 用户在输入框里打的字接在正文后面；发完把输入框还原成他打的那几个字。
 */
export async function submitWithLook(look: LookItem, body: string): Promise<boolean> {
  const store = useStore.getState()
  const check = checkLookSubmission(look, store.inputImages, useLibraryStore.getState().assets)
  if (!check.ok) return false
  const assembled = assembleLookRequest({
    look: { body, slotCount: look.slotCount, referenceImageIds: await referenceImageIds(look) },
    assets: check.assets.map((asset) => ({ id: asset.id, name: asset.name, views: asset.views })),
  })
  if (!assembled.ok) return false

  const typed = store.prompt
  const images = []
  for (const id of assembled.inputImageIds) {
    const dataUrl = await ensureImageCached(id)
    if (dataUrl) images.push({ id, dataUrl })
  }
  store.setInputImages(images)
  store.setPrompt(typed.trim() ? `${assembled.prompt}\n\n${typed.trim()}` : assembled.prompt)
  await submitTask()
  const after = useStore.getState()
  if (after.prompt !== '') after.setPrompt(typed)
  useActiveLook.getState().set(null)
  if (look.record) void useLibraryStore.getState().noteLookUsed(look.record.id)
  return true
}
