import { useRef } from 'react'
import { attachmentStackProgress, attachmentUploadState } from './attachmentUploads'

type Uploadable = Parameters<typeof attachmentStackProgress>[0][number]

/**
 * 收起的那叠参考图显示的总进度只增不减（BUG-53）。一批从有图开始传算起，到全部传完或失败为止；
 * 这期间传完的图仍按 100% 算在里面，中途又加图时停在原处等它追上，不往回跳。
 */
export function useAttachmentStackProgress(references: readonly Uploadable[]): number | undefined {
  const batch = useRef(new Set<string>())
  const peak = useRef<number | undefined>(undefined)
  const active = references.filter((reference) =>
    ['queued', 'uploading', 'verifying'].includes(attachmentUploadState(reference) ?? ''),
  )
  if (!active.length) {
    batch.current.clear()
    peak.current = undefined
    return undefined
  }
  for (const reference of active) batch.current.add(reference.dataUrl)
  const value = attachmentStackProgress(references, batch.current)
  // 换下一张、浏览器还没报字节数时先停在原处，不把已有的百分比收成只转圈。
  if (value === undefined) return peak.current
  peak.current = Math.max(peak.current ?? 0, value)
  return peak.current
}
