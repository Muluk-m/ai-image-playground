import { useTranslation } from '../../../../i18n'
import { formatDate } from '../../../../i18n/format'
import { useStore } from '../../../../store'
import { useStoryboardStore } from '../store'
import DirectorFrame from './DirectorFrame'

export default function StoryboardLibrary({
  onOpen,
  onNew,
}: {
  onOpen: (generate: boolean) => void
  onNew: () => void
}) {
  const { t } = useTranslation('video')
  const records = useStoryboardStore((s) => s.storyboards)
  const open = (id: string, generate: boolean) => {
    useStoryboardStore.getState().select(id)
    onOpen(generate)
  }
  return (
    <section className="vd-project vd-stack">
      <div className="vd-row vd-between">
        <div>
          <h2>{t('library.title')}</h2>
          <p className="vd-muted">{t('library.subtitle')}</p>
        </div>
        <button type="button" className="vd-primary" onClick={onNew}>
          {t('action.newStoryboard')}
        </button>
      </div>
      {records.length === 0 ? (
        <div className="vd-empty">
          <p>{t('library.empty')}</p>
          <button type="button" onClick={onNew}>
            {t('library.new')}
          </button>
        </div>
      ) : (
        <div className="vd-library">
          {records.map((record) => (
            <article key={record.id}>
              {record.shots[0] && <DirectorFrame shot={record.shots[0]} />}
              <div>
                <h3>{record.title}</h3>
                <small>
                  {t('library.meta', {
                    count: record.shots.length,
                    seconds: record.totalSeconds,
                    aspect: record.aspectRatio,
                  })}
                </small>
                <small>
                  {t('library.versions', { count: record.versions?.length ?? 0 })} ·{' '}
                  {formatDate(record.updatedAt)}
                </small>
                <div className="vd-row">
                  <button type="button" onClick={() => open(record.id, false)}>
                    {t('library.load')}
                  </button>
                  <button
                    type="button"
                    className="vd-primary"
                    onClick={() => open(record.id, true)}
                  >
                    {t('action.generateVideo')}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    useStore.getState().setConfirmDialog({
                      title: t('library.delete'),
                      message: t('library.deleteMessage', { title: record.title }),
                      action: () => {
                        void useStoryboardStore.getState().remove(record.id)
                      },
                    })
                  }
                >
                  {t('library.delete')}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
