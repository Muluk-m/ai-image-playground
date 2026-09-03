import { LibraryIcon } from '../../../components/icons'
import { useStore } from '../../../store'
import { useLibraryStore } from '../store'

const STEPS = [
  { token: '右键', text: '参考图存为素材' },
  { token: '@', text: '引用素材' },
  { token: '{槽位}', text: '一次生成多张' },
  { token: '/', text: '调用模板' },
]

export function useLibraryCoachActive(): boolean {
  return useStore(
    (s) =>
      !s.libraryCoachDismissed &&
      !s.libraryPanelOpened &&
      // 灵感库引导的出现条件，两张卡不同屏。
      !(!s.inspirationCoachDismissed && s.tasks.length === 0),
  )
}

/** 只渲染气泡本身；按钮的脉冲动画与定位锚点由 Header 控制。 */
export default function LibraryCoach() {
  const active = useLibraryCoachActive()
  const dismiss = useStore((s) => s.dismissLibraryCoach)
  const openLibrary = useLibraryStore((s) => s.openPanel)

  if (!active) return null

  return (
    <div
      role="dialog"
      aria-label="素材与模板引导"
      className="animate-coach-pop-in absolute right-0 top-full z-50 mt-3 w-72 rounded-2xl border border-blue-100 bg-white p-4 shadow-xl ring-1 ring-black/5 dark:border-blue-500/20 dark:bg-gray-900 dark:ring-white/10"
    >
      <span
        aria-hidden
        className="absolute -top-1.5 right-4 h-3 w-3 rotate-45 border-l border-t border-blue-100 bg-white dark:border-blue-500/20 dark:bg-gray-900"
      />

      <div className="flex items-start gap-2">
        <LibraryIcon className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            同一批图、同一段提示词
          </div>
          <ol className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-gray-400">
            {STEPS.map((step) => (
              <li key={step.token} className="flex items-center gap-1.5">
                <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 dark:bg-white/[0.08] dark:text-gray-200">
                  {step.token}
                </span>
                {step.text}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md px-2.5 py-1 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
        >
          知道了
        </button>
        <button
          type="button"
          onClick={() => {
            dismiss()
            openLibrary()
          }}
          className="inline-flex items-center gap-1 rounded-md bg-blue-500 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-blue-600"
        >
          <LibraryIcon className="h-3 w-3" />
          看看
        </button>
      </div>
    </div>
  )
}
