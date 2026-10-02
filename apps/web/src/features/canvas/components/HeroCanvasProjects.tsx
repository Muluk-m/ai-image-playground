import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import ProjectGrid from './ProjectGrid'

/** 对话与画布各自显示最近的同类项目，并提供空白创建入口。 */
export default function HeroCanvasProjects({ experience }: { experience: 'chat' | 'canvas' }) {
  const { t } = useTranslation(['canvas', 'shell'])
  const openProjects = useLibraryStore((s) => s.openProjects)
  const create = async () => {
    if (!(await useAgentStore.getState().createProject(undefined, false, experience))) return
    useStore.getState().setAppMode('canvas')
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 pb-5 pt-10 sm:gap-4">
        <h2 className="text-title font-semibold">
          {t(experience === 'chat' ? 'shell:nav.chats' : 'shell:nav.canvases')}
        </h2>
        <button
          type="button"
          onClick={() => void create()}
          className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
        >
          {t(experience === 'chat' ? 'shell:nav.newChat' : 'shell:nav.newCanvas')}
        </button>
        <button
          type="button"
          onClick={openProjects}
          className="ml-auto text-body-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('shell:nav.allCanvases')} →
        </button>
      </div>
      <ProjectGrid recent experience={experience} />
    </>
  )
}
