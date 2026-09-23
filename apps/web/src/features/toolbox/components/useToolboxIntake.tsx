import { useRef } from 'react'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
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
  const { dragging, dropZoneProps } = useImageDropZone((files) => void add(files))
  usePasteImageFiles('tools', (files) => void add(files))

  const inputs = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void add(acceptImageFiles([...(event.target.files ?? [])]))
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
          void add(acceptImageFiles(files))
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
