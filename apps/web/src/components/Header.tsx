import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import InspirationCoach from '../features/inspiration/components/InspirationCoach'
import { useInspirationStore } from '../features/inspiration/store'
import { useTooltip } from '../hooks/useTooltip'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { PrivateWebHeaderActions } from '../lib/privateOverlay'
import { useStore } from '../store'
import HelpModal from './HelpModal'
import { SparkleIcon } from './icons'
import ViewportTooltip from './ViewportTooltip'

export default function Header() {
  const setShowSettings = useStore((s) => s.setShowSettings)
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const [showHelp, setShowHelp] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const auth = useAuth()

  const openInspiration = useInspirationStore((s) => s.openPanel)
  const dismissInspirationCoach = useStore((s) => s.dismissInspirationCoach)
  const inspirationCoachActive = useStore(
    (s) => !s.inspirationCoachDismissed && s.tasks.length === 0,
  )

  const inspirationTooltip = useTooltip()
  const helpTooltip = useTooltip()
  const settingsTooltip = useTooltip()

  return (
    <>
      <header
        data-no-drag-select
        className="safe-area-top fixed top-0 left-0 right-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-white/[0.08]"
      >
        <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex-1 min-w-0 pr-2">
            <h1 className="inline-flex items-center gap-2.5 font-display text-[18px] sm:text-[19px] font-medium tracking-wide text-gray-900 dark:text-gray-50">
              <img
                src="./pwa-icon.svg"
                alt=""
                width="24"
                height="24"
                className="h-6 w-6 rounded-md shrink-0"
              />
              Image Playground
            </h1>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <div className="flex items-center gap-0.5 mr-1 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-900">
              {(['browse', 'create'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setAppMode(mode)}
                  className={`px-2.5 py-1 text-[13px] font-medium rounded-md transition-colors ${
                    appMode === mode
                      ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-50 shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}
                  aria-pressed={appMode === mode}
                >
                  {mode === 'browse' ? '工作台' : '创作'}
                </button>
              ))}
            </div>
            <div className="relative" {...inspirationTooltip.handlers}>
              <button
                onClick={() => {
                  dismissAllTooltips()
                  dismissInspirationCoach()
                  openInspiration()
                }}
                className={`p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors ${
                  inspirationCoachActive ? 'animate-coach-pulse' : ''
                }`}
                aria-label="灵感库"
              >
                <SparkleIcon
                  className={`w-5 h-5 ${
                    inspirationCoachActive ? 'text-blue-500' : 'text-gray-600 dark:text-gray-400'
                  }`}
                />
              </button>
              <ViewportTooltip visible={inspirationTooltip.visible} className="whitespace-nowrap">
                灵感库
              </ViewportTooltip>
              {inspirationCoachActive && <InspirationCoach />}
            </div>
            <div className="relative" {...helpTooltip.handlers}>
              <button
                onClick={() => {
                  dismissAllTooltips()
                  setShowHelp(true)
                }}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                aria-label="操作指南"
              >
                <svg
                  className="w-5 h-5 text-gray-600 dark:text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  viewBox="0 0 24 24"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
              </button>
              <ViewportTooltip visible={helpTooltip.visible} className="whitespace-nowrap">
                操作指南
              </ViewportTooltip>
            </div>
            <div className="relative" {...settingsTooltip.handlers}>
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                aria-label="设置"
              >
                <svg
                  className="w-5 h-5 text-gray-600 dark:text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </button>
              <ViewportTooltip visible={settingsTooltip.visible} className="whitespace-nowrap">
                设置
              </ViewportTooltip>
            </div>
            <PrivateWebHeaderActions />
            {auth.enabled && auth.user ? (
              <div className="ml-1 flex items-center gap-2 border-l border-gray-200 pl-2 dark:border-white/[0.1]">
                <span
                  className="hidden max-w-28 truncate text-[12px] font-medium text-gray-600 sm:block dark:text-gray-300"
                  title={auth.user.username}
                >
                  {auth.user.username}
                </span>
                <button
                  type="button"
                  disabled={loggingOut}
                  onClick={() => {
                    setLoggingOut(true)
                    void auth.logout()
                  }}
                  className="rounded-lg px-2 py-1.5 text-[12px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:cursor-wait disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-100"
                >
                  {loggingOut ? '退出中' : '退出'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className="safe-area-top invisible pointer-events-none" aria-hidden="true">
        <div className="safe-header-inner" />
      </div>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </>
  )
}
