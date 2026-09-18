import { useTranslation } from '../../../i18n'
import AgentComposer from '../../agent/components/AgentComposer'
import AgentHistoryStatus from '../../agent/components/AgentHistoryStatus'
import AgentSuggestions from '../../agent/components/AgentSuggestions'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import type { CanvasWorkspace } from '../lib/workspaces'
import ProjectGrid from './ProjectGrid'
import ProjectSyncStatus from './ProjectSyncStatus'

export default function ProjectWelcome({ workspace }: { workspace: CanvasWorkspace }) {
  const { t } = useTranslation('canvas')
  const error = useAgentStore((state) => state.error)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  return (
    <main
      className="h-full w-full overflow-y-auto bg-background px-6 pb-12"
      style={{
        backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      <section
        className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center gap-7 py-12"
        aria-label={t('welcome.aria')}
      >
        <img src="/brand/muvloom-icon.svg" alt="Muvloom" className="h-14 w-14" />
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {t('welcome.title')}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">{t('welcome.subtitle')}</p>
        </div>
        <div className="w-full">
          {workspace.cloud && (
            <div className="mb-3">
              <ProjectSyncStatus session={workspace.cloud} />
            </div>
          )}
          <AgentComposer doc={workspace.doc} editor={workspace.editor} welcome />
          <AgentSuggestions className="mt-4 sm:grid-cols-3" />
          <AgentHistoryStatus />
          {error && !historyFailed && (
            <p role="alert" className="mt-3 text-sm text-muted-foreground">
              {error}
            </p>
          )}
        </div>
      </section>
      <section className="mx-auto max-w-6xl" aria-label={t('welcome.recent')}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('welcome.recent')}</h2>
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => useLibraryStore.getState().openPanel('projects')}
          >
            {t('welcome.allProjects')}
          </button>
        </div>
        <ProjectGrid recent />
      </section>
    </main>
  )
}
