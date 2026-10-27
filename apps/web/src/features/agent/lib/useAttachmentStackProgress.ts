import { useEffect, useRef } from 'react'
import { attachmentStackProgress, attachmentUploadState } from './attachmentUploads'

type Uploadable = Parameters<typeof attachmentStackProgress>[0][number]

const ACTIVE = new Set(['queued', 'uploading', 'verifying'])

/**
 * 收起的那叠参考图显示的总进度只增不减（BUG-53）。一批从有图开始传算起，到全部传完或失败为止；
 * 这期间传完的图仍按 100% 算在里面，中途又加图时停在原处等它追上，不往回跳。
 * render 只读已提交的这批和最高值，提交后才在 effect 里记下，被丢弃的 render 不会改掉它们。
 */
export function useAttachmentStackProgress(references: readonly Uploadable[]): number | undefined {
  const batch = useRef<ReadonlySet<string>>(new Set())
  const peak = useRef<number | undefined>(undefined)
  const active = references.filter((reference) =>
    ACTIVE.has(attachmentUploadState(reference) ?? ''),
  )
  const current = active.length
    ? new Set([...batch.current, ...active.map((reference) => reference.dataUrl)])
    : undefined
  const value = current ? attachmentStackProgress(references, current) : undefined
  // 换下一张、浏览器还没报字节数时先停在原处，不把已有的百分比收成只转圈。
  const shown = !current
    ? undefined
    : value === undefined
      ? peak.current
      : Math.max(peak.current ?? 0, value)

  useEffect(() => {
    batch.current = current ?? new Set()
    peak.current = shown
  })

  return shown
}
