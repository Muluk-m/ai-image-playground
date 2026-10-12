import ProjectCover from '../../features/canvas/components/ProjectCover'
import { useTranslation } from '../../i18n'
import MediaImage from '../MediaImage'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import type { CreationReference } from './draft'

export function AssetGallery({
  items,
  selected,
  onToggle,
  onPreview,
}: {
  items: readonly CreationReference[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  onPreview: (item: CreationReference) => void
}) {
  const { t } = useTranslation('composer')
  return (
    <div className="creation-asset-grid">
      {items.map((item) => (
        <div key={item.id} className="creation-asset-tile" data-selected={selected.has(item.id)}>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onPreview(item)}
            aria-label={`${t('studio.preview')} ${item.name}`}
          >
            <MediaImage src={item.src} alt={item.name} loading="lazy" />
            {item.kind === 'video' && (
              <span className="creation-play-badge">
                <Icon name="play" />
              </span>
            )}
          </Button>
          <Button
            variant="secondary"
            className="creation-asset-select"
            aria-label={`${t('studio.select')} ${item.name}`}
            aria-pressed={selected.has(item.id)}
            onClick={() => onToggle(item.id)}
          >
            {selected.has(item.id) && <Icon name="check" />}
          </Button>
        </div>
      ))}
    </div>
  )
}
export interface CreationProject {
  id: string
  name: string
  date: string
  kind: 'image' | 'video' | 'agent'
  cover?: string
}
export function ProjectCard({
  project,
  onOpen,
  onMenu,
}: {
  project: CreationProject
  onOpen: () => void
  onMenu: () => void
}) {
  const { t } = useTranslation('composer')
  const emptyIcon = project.kind === 'agent' ? 'chat' : 'image'
  return (
    <article className="creation-project-card">
      <Button variant="ghost" type="button" className="creation-project-open" onClick={onOpen}>
        <div className="creation-project-cover">
          {project.cover ? (
            <ProjectCover source={project.cover} chat={project.kind === 'agent'} fit="cover" />
          ) : (
            <div className="creation-project-empty">
              <Icon name={emptyIcon} size="lg" />
            </div>
          )}
          {project.kind === 'video' && (
            <span className="creation-play-badge">
              <Icon name="play" />
            </span>
          )}
        </div>
        <div className="creation-project-info">
          <h3>{project.name}</h3>
          <p>{project.date}</p>
        </div>
      </Button>
      <Button
        variant="ghost"
        className="creation-project-menu"
        size="icon"
        aria-label={`${t('studio.projectActions')} ${project.name}`}
        onClick={onMenu}
      >
        <Icon name="more" />
      </Button>
    </article>
  )
}
export function NewProjectCard({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation('composer')
  return (
    <article className="creation-project-card">
      <Button variant="ghost" type="button" className="creation-project-open" onClick={onCreate}>
        <div className="creation-project-cover creation-new-project">
          <Icon name="add" />
          <span>{t('studio.start')}</span>
        </div>
        <div className="creation-project-info">
          <h3>{t('studio.newProject')}</h3>
        </div>
      </Button>
    </article>
  )
}
