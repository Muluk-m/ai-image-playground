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
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/50 bg-card p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in border-border dark:ring-white/10">
        <h3 className="text-base font-semibold text-foreground">退出登录</h3>

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
            className="rounded-xl px-4 py-2 text-sm text-muted-foreground transition hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(clearLocalData)}
            className={`rounded-xl px-4 py-2 text-sm font-medium text-white shadow-sm transition ${
              clearLocalData
                ? 'bg-destructive hover:bg-destructive/90'
                : 'bg-primary hover:bg-primary/90'
            }`}
          >
            退出
          </button>
        </div>
      </div>
    </Overlay>
  )
}
