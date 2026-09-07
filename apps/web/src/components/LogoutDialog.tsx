import { useState } from 'react'
import { Checkbox } from './Checkbox'
import Overlay from './Overlay'

interface LogoutDialogProps {
  onCancel: () => void
  onConfirm: (clearLocalData: boolean) => void
}

/** 退出登录的确认框。勾选后连同当前用户 scope 的本机缓存一起删掉。 */
export default function LogoutDialog({ onCancel, onConfirm }: LogoutDialogProps) {
  const [clearLocalData, setClearLocalData] = useState(false)

  return (
    <Overlay onClose={onCancel} tier="alert">
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/50 bg-white p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 dark:ring-white/10">
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">退出登录</h3>

        <Checkbox
          checked={clearLocalData}
          onChange={setClearLocalData}
          label="同时清除本机数据"
          tone="danger"
          className="mt-4"
        />

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(clearLocalData)}
            className={`rounded-xl px-4 py-2 text-sm font-medium text-white shadow-sm transition ${
              clearLocalData ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'
            }`}
          >
            退出
          </button>
        </div>
      </div>
    </Overlay>
  )
}
