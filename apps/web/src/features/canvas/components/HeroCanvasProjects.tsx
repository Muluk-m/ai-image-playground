import { useTranslation } from '../../../i18n'
import { useLibraryStore } from '../../library/store'
import ProjectGrid from './ProjectGrid'

/** 项目创作入口显示最近项目。 */
export default function HeroCanvasProjects() {
  const { t } = useTranslation(['canvas', 'shell'])
  const openProjects = useLibraryStore((s) => s.openProjects)
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 pb-5 pt-10 sm:gap-4">
        <h2 className="text-[15px] font-semibold">{t('shell:nav.canvases')}</h2>
        <button
          type="button"
          onClick={openProjects}
          className="ml-auto text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('shell:nav.allCanvases')} →
        </button>
      </div>
      <ProjectGrid recent />
    </>
  )
}
