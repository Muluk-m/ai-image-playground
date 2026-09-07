import { useEffect, useRef } from 'react'
import { acceptImageFiles } from '../lib/imageFiles'
import { type ImageInputScope, useImageInputScope } from './useImageInputScope'

function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  return [...data.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function usePasteImageFiles(scope: ImageInputScope, onFiles: (files: File[]) => void) {
  const active = useImageInputScope() === scope
  const latest = useRef(onFiles)
  latest.current = onFiles

  useEffect(() => {
    if (!active) return
    const onPaste = (event: ClipboardEvent) => {
      const files = clipboardFiles(event.clipboardData)
      if (files.length === 0) return
      const images = acceptImageFiles(files)
      if (images.length === 0) return
      event.preventDefault()
      // 画布模式的粘贴挂在 window 上，不停传播会把同一张图收两遍。
      event.stopPropagation()
      latest.current(images)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [active])
}
