import { PlusIcon } from '../../../components/icons'

/** 参考图缩略图 + 右键菜单：告诉用户素材从哪来。 */
function SaveAssetIllustration() {
  return (
    <svg
      data-empty-illustration
      viewBox="0 0 104 64"
      className="h-16 w-auto text-gray-300 dark:text-gray-600"
      fill="none"
      aria-hidden="true"
    >
      <rect x="4" y="8" width="44" height="44" rx="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="22" r="4" fill="currentColor" />
      <path
        d="M9 44l11-12 9 10 6-6 8 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M42 30l0 14 4-4 3 7 3-1-3-7 5 0z" fill="currentColor" />
      <rect
        x="54"
        y="34"
        width="46"
        height="24"
        rx="5"
        className="fill-white dark:fill-gray-900"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect x="60" y="41" width="26" height="3" rx="1.5" fill="currentColor" />
      <rect x="60" y="49" width="18" height="3" rx="1.5" className="fill-blue-500" />
    </svg>
  )
}

export function AssetsEmpty({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 pt-12 text-center">
      <SaveAssetIllustration />
      <p className="text-sm text-gray-500 dark:text-gray-400">
        右键参考图缩略图，选择存为素材
        <span className="mt-1 block text-xs text-gray-400 dark:text-gray-500">
          手机上长按缩略图
        </span>
      </p>
      <button
        type="button"
        onClick={onImport}
        className="flex items-center gap-1 rounded-lg bg-blue-500/10 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-500/20 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25"
      >
        <PlusIcon className="h-4 w-4" />
        新建素材
      </button>
    </div>
  )
}

export function TemplatesEmpty() {
  return (
    <p className="pt-16 text-center text-sm text-gray-500 dark:text-gray-400">
      写好提示词后点存为模板，输入 / 调用
    </p>
  )
}
