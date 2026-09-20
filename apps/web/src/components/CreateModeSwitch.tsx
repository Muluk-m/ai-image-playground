import { useAgentStore } from '../features/agent/store'
import { useCanvasProjectStore } from '../features/canvas/projectStore'
import { useTranslation } from '../i18n'
import { useStore } from '../store'

/**
 * 「创作」入口里的两种模式：生成（纯提示词直出）与画布（画布 + 智能体）。
 * 它们不是两个入口——选的是怎么做，不是去哪。画布模式落到上次那个项目，没有就新建一个。
 */
export default function CreateModeSwitch() {
  const { t } = useTranslation('shell')
  const appMode = useStore((state) => state.appMode)
  const canvas = appMode === 'canvas'

  const enterCanvas = async () => {
    const { activeId } = useCanvasProjectStore.getState()
    const agent = useAgentStore.getState()
    const opened = activeId ? await agent.selectProject(activeId) : await agent.createProject()
    if (opened) useStore.getState().setAppMode('canvas')
  }

  return (
    <div className="mx-auto flex w-fit items-center gap-1 rounded-full border border-border bg-card/70 p-1 backdrop-blur-sm">
      <button
        type="button"
        aria-pressed={!canvas}
        onClick={() => useStore.getState().setAppMode('image')}
        className={`rounded-full px-9 py-2 text-[14px] transition-colors ${
          canvas ? 'text-muted-foreground hover:text-foreground' : 'studio-mode-active'
        }`}
      >
        {t('mode.generate')}
      </button>
      <button
        type="button"
        aria-pressed={canvas}
        onClick={() => void enterCanvas()}
        className={`rounded-full px-9 py-2 text-[14px] transition-colors ${
          canvas ? 'studio-mode-active' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        {t('mode.canvas')}
      </button>
    </div>
  )
}
