import { type DragEvent, useRef, useState } from 'react'
import { acceptImageFiles } from '../lib/imageFiles'

function carriesFiles(event: DragEvent) {
  return [...event.dataTransfer.types].includes('Files')
}

/**
 * 把一块区域变成图片落点。停传播是必须的：工作台在 document 上另有一套全屏拖拽接管，
 * 不拦住它就会同时点亮两个落点。
 */
export function useImageDropZone(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false)
  // 拖过子元素时 dragenter / dragleave 成对乱序触发，只有计数才不会中途熄灭。
  const depth = useRef(0)

  const stop = () => {
    depth.current = 0
    setDragging(false)
  }

  return {
    dragging,
    dropZoneProps: {
      'data-image-dropzone': true,
      onDragEnter: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        depth.current += 1
        setDragging(true)
      },
      onDragOver: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
      },
      onDragLeave: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.stopPropagation()
        depth.current -= 1
        if (depth.current <= 0) stop()
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        stop()
        const images = acceptImageFiles([...event.dataTransfer.files])
        if (images.length > 0) onFiles(images)
      },
    },
  }
}
