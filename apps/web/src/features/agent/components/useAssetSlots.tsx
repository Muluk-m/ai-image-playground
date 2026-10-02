import { type ReactNode, useRef } from 'react'
import { i18next } from '../../../i18n'
import {
  assetSlotAt,
  assetSlotImages,
  clearAssetSlot,
  fillAssetSlot,
} from '../../../lib/assetSlotDraft'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { getPromptAssetSlots, type PromptAssetSlot } from '../../../lib/promptImageMentions'
import {
  type ReferenceAdmission,
  type ReferenceDraft,
  type ReferenceRefusal,
  referenceRefusal,
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

/**
 * 一位此刻的样子：异步操作落地时要还是它，不然这次结果作废。位的总数也算进去——前面删掉一个
 * 位，后面一模一样的位会挪到这个位次上，光看这一位分不出来。
 */
function slotIdentity(prompt: string, occurrence: number): string {
  const slots = getPromptAssetSlots(prompt)
  const slot = slots[occurrence]
  return slot ? JSON.stringify([slots.length, slot.key, slot.label, slot.imageIndexes]) : ''
}

/** 返回给 `usePromptEditor` 的 `renderSlot`。 */
export function useAssetSlots<D extends ReferenceDraft>(
  host: AssetSlotHost<D>,
): (slot: PromptAssetSlot, occurrence: number) => ReactNode {
  /**
   * 每一位最近一次操作的序号。读图、读文件是异步的：先选的慢素材不能盖掉后传的图，
   * 读的期间清空了位，旧结果也不能再填回去。
   */
  const tickets = useRef(new Map<number, number>())
  const begin = (occurrence: number) => {
    const ticket = (tickets.current.get(occurrence) ?? 0) + 1
    tickets.current.set(occurrence, ticket)
    const before = slotIdentity(host.read().prompt, occurrence)
    return (current: string) =>
      tickets.current.get(occurrence) === ticket && slotIdentity(current, occurrence) === before
  }

  const fill = (
    occurrence: number,
    key: string,
    images: readonly SlotReference<D>[],
    still: (prompt: string) => boolean,
  ) => {
    if (host.accepting && !host.accepting()) return
    const current = host.read()
    if (!still(current.prompt) || !assetSlotAt(current.prompt, occurrence, key)) return
    const next = fillAssetSlot(current, occurrence, images, host.admission())
    if (next.ok) host.write(next.draft)
    else toast(host.refusalMessage(next.reason))
  }

  const pickAsset = async (occurrence: number, key: string, asset: AssetRecord) => {
    const still = begin(occurrence)
    const image = await assetSlotImage(asset).catch(() => null)
    if (!image) {
      toast(i18next.t('library:toast.assetImageMissing'))
      return
    }
    // 只影响「最近用过」的排序，记不上不该拦下这次填位。
    void useLibraryStore
      .getState()
      .noteAssetUsed(asset.id)
      .catch(() => {})
    fill(occurrence, key, [host.fromAsset(image, asset)], still)
  }

  /**
   * 读文件之前先问一声：这一批单独就超出上限、或这一头根本不收参考图时，一张都不读、不落盘。
   * 条里已有的图不算进去——上传的可能就是条里那张（按内容去重），读完以后填位时再按实际新增数判。
   */
  const upload = (occurrence: number, key: string, files: File[]) => {
    const admission = host.admission()
    const refusal = referenceRefusal({ total: 0 }, { total: files.length }, admission)
    if (refusal) {
      toast(host.refusalMessage(refusal))
      return
    }
    // 确认框开着的时候别的操作落地了，这一批也要作废：凭据在问之前就领。
    const still = begin(occurrence)
    confirmImageBatch(files.length, () => {
      if (!still(host.read().prompt)) return
      void (async () => {
        try {
          fill(occurrence, key, await host.fromFiles(files), still)
        } catch {
          toast(i18next.t('agent:composer.attachmentReadFailed'))
        }
      })()
    })
  }

  const clear = (occurrence: number) => {
    begin(occurrence)
    host.write(clearAssetSlot(host.read(), occurrence))
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
        onUpload={(files) => upload(occurrence, slot.key, files)}
        onClear={() => clear(occurrence)}
      />
    )
  }
}
