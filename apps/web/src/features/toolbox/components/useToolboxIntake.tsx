import { useRef } from 'react'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { acceptImageFiles, filesFromFolderInput } from '../../../lib/imageFiles'
import { useToolboxStore } from '../store'

/**
 * 收图：拖入、粘贴、选文件、选文件夹四条路进同一个 `add`。
 * 粘贴按入口分域（`usePasteImageFiles('tools')`），别的页面正在接粘贴时这里不抢。
 */
export function useToolboxIntake() {
  const add = useToolboxStore((state) => state.add)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  /** 四条路都汇到这里：非图片已经筛掉，剩下的一次进太多就先问一声，确认了才解码入列。 */
  const intake = (images: File[]) => {
    if (images.length === 0) return
    confirmImageBatch(images.length, () => void add(images))
  }
  const { dragging, dropZoneProps } = useImageDropZone(intake)
  usePasteImageFiles('tools', intake)

  const inputs = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          intake(acceptImageFiles([...(event.target.files ?? [])]))
          event.target.value = ''
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        // 文件夹选择器没有 React 的 prop 名，只能按 DOM 属性名直接摊上去。
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          const { files } = filesFromFolderInput(event.target.files)
          intake(acceptImageFiles(files))
          event.target.value = ''
        }}
      />
    </>
  )

  return {
    dragging,
    dropZoneProps,
    inputs,
    openFiles: () => fileInput.current?.click(),
    openFolder: () => folderInput.current?.click(),
  }
}
