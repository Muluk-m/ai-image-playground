import { useEffect, useRef, useState } from 'react'
import Overlay from '../../../components/Overlay'
import { useLibraryStore } from '../store'
import AssetThumb from './AssetThumb'

export default function SaveAssetDialog() {
  const imageId = useLibraryStore((s) => s.namingImageId)
  const cancelNaming = useLibraryStore((s) => s.cancelNaming)
  const saveAsset = useLibraryStore((s) => s.saveAsset)
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setName('')
    inputRef.current?.focus()
  }, [imageId])

  if (!imageId) return null

  const trimmed = name.trim()

  return (
    <Overlay onClose={cancelNaming} tier="raised">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed) void saveAsset(imageId, trimmed)
        }}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/50 bg-white p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10"
      >
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">存为素材</h3>

        <div className="mt-4 flex items-center gap-3">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
            <AssetThumb imageId={imageId} alt="" />
          </div>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="素材名"
            maxLength={40}
            className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100 dark:focus:border-blue-500/50 dark:focus:ring-blue-500/15"
          />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancelNaming}
            className="rounded-xl px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!trimmed}
            className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 dark:disabled:bg-white/10 dark:disabled:text-gray-500"
          >
            保存
          </button>
        </div>
      </form>
    </Overlay>
  )
}
