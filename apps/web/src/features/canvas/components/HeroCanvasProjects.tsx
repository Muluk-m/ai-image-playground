import { useTranslation } from '../../../i18n'
import { useLibraryStore } from '../../library/store'
import ProjectGrid from './ProjectGrid'

/** 对话与画布各自显示最近的同类项目。新建靠上面的输入框：发出去就是一个新项目，不另给空白入口。 */
export default function HeroCanvasProjects({ experience }: { experience: 'chat' | 'canvas' }) {
  const { t } = useTranslation(['canvas', 'shell'])
  const openProjects = useLibraryStore((s) => s.openProjects)
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 pb-5 pt-10 sm:gap-4">
        <h2 className="text-title font-semibold">
          {t(experience === 'chat' ? 'shell:nav.chats' : 'shell:nav.canvases')}
        </h2>
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
