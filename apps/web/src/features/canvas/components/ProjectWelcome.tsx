import AgentComposer from '../../agent/components/AgentComposer'
import AgentHistoryStatus from '../../agent/components/AgentHistoryStatus'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import type { CanvasWorkspace } from '../lib/workspaces'
import ProjectGrid from './ProjectGrid'
import ProjectSyncStatus from './ProjectSyncStatus'

export default function ProjectWelcome({ workspace }: { workspace: CanvasWorkspace }) {
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
        aria-label="开始新项目"
      >
        <img src="/brand/muvloom-icon.svg" alt="Muvloom" className="h-14 w-14" />
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            让想法，从这里展开。
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            描述你想创作的画面，或添加一张参考图。
          </p>
        </div>
        <div className="w-full">
          {workspace.cloud && (
            <div className="mb-3">
              <ProjectSyncStatus session={workspace.cloud} />
            </div>
          )}
          <AgentComposer doc={workspace.doc} editor={workspace.editor} welcome />
          <AgentHistoryStatus />
          {error && !historyFailed && (
            <p role="alert" className="mt-3 text-sm text-muted-foreground">
              {error}
            </p>
          )}
        </div>
      </section>
      <section className="mx-auto max-w-6xl" aria-label="最近项目">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">最近项目</h2>
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => useLibraryStore.getState().openPanel('projects')}
          >
            全部项目 →
          </button>
        </div>
        <ProjectGrid recent />
      </section>
    </main>
  )
}
