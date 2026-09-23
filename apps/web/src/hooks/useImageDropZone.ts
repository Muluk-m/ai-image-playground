import { type DragEvent, useRef, useState } from 'react'
import { dropEntries, expandDroppedFiles } from '../lib/dropFiles'
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
      // 离开事件不问带的是什么：有的浏览器这时已经不给 types 了，问了就永远熄不掉高亮。
      onDragLeave: (event: DragEvent) => {
        if (depth.current === 0) return
        event.stopPropagation()
        depth.current -= 1
        if (depth.current <= 0) stop()
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        stop()
        // entry 必须在这一拍同步取完：await 之后 DataTransfer 就空了。
        const dropped = dropEntries(event.dataTransfer)
        void expandDroppedFiles(dropped).then((files) => {
          const images = acceptImageFiles(files)
          if (images.length > 0) onFiles(images)
        })
      },
    },
  }
}
