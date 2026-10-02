import type { ReactNode } from 'react'
import { i18next } from '../../../i18n'
import {
  assetSlotAt,
  assetSlotImages,
  clearAssetSlot,
  fillAssetSlot,
} from '../../../lib/assetSlotDraft'
import type { PromptAssetSlot } from '../../../lib/promptImageMentions'
import type {
  ReferenceAdmission,
  ReferenceDraft,
  ReferenceRefusal,
} from '../../../lib/referenceDraft'
import { useStore } from '../../../store'
import type { InputImage } from '../../../types'
import { assetSlotImage, useLibraryStore } from '../../library/store'
import type { AssetRecord } from '../../library/types'
import AssetSlotChip, { type AssetSlotImage } from './AssetSlotChip'

/**
 * 输入框交给素材位的那几样：怎么读写自己的草稿、准入、文件怎么变成参考图。首页对话输入框与
 * 项目 `AgentComposer` 各给一份，填位、清位与胶囊的接线只在这里写一遍。
 */
export interface AssetSlotHost<D extends ReferenceDraft> {
  readonly read: () => D
  readonly write: (draft: D) => void
  readonly admission: () => ReferenceAdmission<SlotReference<D>>
  readonly refusalMessage: (reason: ReferenceRefusal) => string
  /** 素材里选中的那张视角 → 本输入框的参考图。 */
  readonly fromAsset: (image: InputImage, asset: AssetRecord) => SlotReference<D>
  /** 上传 / 拖进来的文件 → 本输入框的参考图。只是这一轮的参考图，不建素材。 */
  readonly fromFiles: (files: File[]) => SlotReference<D>[] | Promise<SlotReference<D>[]>
  /** 胶囊上那张图叫什么。 */
  readonly imageName: (image: SlotReference<D>) => string | undefined
  /** 草稿还没恢复、读图期间换了会话之类：返回 false 就不往里放（要提示的自己提示）。 */
  readonly accepting?: () => boolean
}

type SlotReference<D extends ReferenceDraft> = D['references'][number]

function toast(message: string): void {
  useStore.getState().showToast(message, 'error')
}

/** 返回给 `usePromptEditor` 的 `renderSlot`。 */
export function useAssetSlots<D extends ReferenceDraft>(
  host: AssetSlotHost<D>,
): (slot: PromptAssetSlot, occurrence: number) => ReactNode {
  /** 读图是异步的，落地时那一位要还在原处，不然宁可不放。 */
  const fill = (occurrence: number, key: string, images: readonly SlotReference<D>[]) => {
    if (host.accepting && !host.accepting()) return
    const current = host.read()
    if (!assetSlotAt(current.prompt, occurrence, key)) return
    const next = fillAssetSlot(current, occurrence, images, host.admission())
    if (next.ok) host.write(next.draft)
    else toast(host.refusalMessage(next.reason))
  }

  const pickAsset = async (occurrence: number, key: string, asset: AssetRecord) => {
    const image = await assetSlotImage(asset).catch(() => null)
    if (!image) {
      toast(i18next.t('library:toast.assetImageMissing'))
      return
    }
    void useLibraryStore.getState().noteAssetUsed(asset.id)
    fill(occurrence, key, [host.fromAsset(image, asset)])
  }

  const upload = async (occurrence: number, key: string, files: File[]) => {
    try {
      fill(occurrence, key, await host.fromFiles(files))
    } catch {
      toast(i18next.t('agent:composer.attachmentReadFailed'))
    }
  }

  return (slot, occurrence) => {
    const images: AssetSlotImage[] = assetSlotImages(slot, host.read().references).map((image) => ({
      src: image.dataUrl,
      name: host.imageName(image),
    }))
    return (
      <AssetSlotChip
        slot={slot}
        images={images}
        onPickAsset={(asset) => void pickAsset(occurrence, slot.key, asset)}
        onUpload={(files) => void upload(occurrence, slot.key, files)}
        onClear={() => host.write(clearAssetSlot(host.read(), occurrence))}
      />
    )
  }
}
