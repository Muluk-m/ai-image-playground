import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import AgentComposer from '../../agent/components/AgentComposer'
import AgentHistoryStatus from '../../agent/components/AgentHistoryStatus'
import { fillAgentComposer } from '../../agent/lib/composerFill'
import { useAgentStore } from '../../agent/store'
import { useLibraryStore } from '../../library/store'
import { useCanvasComposer } from '../composerStore'
import { exampleClipUrl, videoExamples } from '../lib/creationExamples'
import type { CanvasWorkspace } from '../lib/workspaces'
import CanvasVideoParams from './CanvasVideoParams'
import CreationInspiration from './CreationInspiration'
import ProjectGrid from './ProjectGrid'
import ProjectSyncStatus from './ProjectSyncStatus'

/**
 * 空项目的落地页：画布先不摊开，整屏只有一张 composer 卡加案例与最近项目；发出第一句话之后
 * 才换成对话 + 画布的分栏。图片档和视频档是同一张卡，只有参数那一行按当前档位换。
 *
 * 输入框用的是 `AgentComposer`——技能胶囊、`@` 引用画布与素材、草稿持久化都长在它身上，
 * 落地页另做一个简版会让第一句话用不了这些。
 */
export default function ProjectWelcome({ workspace }: { workspace: CanvasWorkspace }) {
  const { t } = useTranslation(['canvas', 'agent', 'video'])
  const error = useAgentStore((state) => state.error)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  const mode = useCanvasComposer((state) => state.mode)
  const video = mode === 'video'
  const examples = videoExamples()

  return (
    <main
      className="h-full w-full overflow-y-auto bg-background px-6 pb-12"
      style={{
        backgroundImage: 'radial-gradient(hsl(var(--border)) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      <section
        className="mx-auto flex w-full max-w-3xl flex-col items-center gap-7 pb-10 pt-[9vh]"
        aria-label={t('welcome.aria')}
      >
        <img src="/brand/muvloom-mark.svg" alt="Muvloom" className="h-14 w-14" />
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {video ? t('video:landing.title') : t('welcome.title')}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {video ? t('video:landing.subtitle') : t('welcome.subtitle')}
          </p>
        </div>
        <div className="w-full">
          {workspace.cloud && (
            <div className="mb-3">
              <ProjectSyncStatus session={workspace.cloud} />
            </div>
          )}
          {/* 渐变描边只是一层背景，内层自己铺卡面。 */}
          <div className="rounded-[22px] bg-gradient-to-br from-primary/40 via-primary/10 to-transparent p-[1.5px] shadow-[0_24px_60px_-30px_hsl(var(--primary)/0.4)]">
            <div className="rounded-[21px] bg-card p-3">
              {/*
                图片档的参数不在这里：AgentComposer 底部那枚 chip 已经带着模型、尺寸与思考深度，
                展开还能改格式与质量。再摆一行 ParamControls 就是同一组参数出现两次，
                而且它里面的透明、防改写、张数在智能体这条路上根本不生效（见 AgentParamsChip）。
              */}
              {video && (
                <div className="mb-2 px-1">
                  <CanvasVideoParams hasFirstFrame={false} />
                </div>
              )}
              <AgentComposer doc={workspace.doc} editor={workspace.editor} welcome />
            </div>
          </div>
          <AgentHistoryStatus />
          {error && !historyFailed && (
            <p role="alert" className="mt-3 text-sm text-muted-foreground">
              {error}
            </p>
          )}
        </div>

        {video ? (
          <div className="w-full">
            <h2 className="mb-3 text-sm font-semibold">
              {t('video:landing.cases')}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {t('video:landing.casesHint')}
              </span>
            </h2>
            <ul aria-label={t('agent:suggestions.aria')} className="grid gap-2 sm:grid-cols-2">
              {examples.map((example) => (
                <li key={example.id}>
                  <button
                    type="button"
                    data-prompt={example.prompt}
                    onClick={() => fillAgentComposer(example.prompt)}
                    className="w-full overflow-hidden rounded-xl border border-border bg-background/60 text-left transition-colors hover:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="relative block">
                      {/* 封面是 poster，悬停 / 聚焦才拉样片：首屏不为四条 720p 片子付流量。 */}
                      <video
                        src={exampleClipUrl(example.id)}
                        poster={example.cover}
                        muted
                        loop
                        playsInline
                        preload="none"
                        tabIndex={-1}
                        aria-hidden
                        className="aspect-[16/9] w-full object-cover"
                        onMouseEnter={(event) => void event.currentTarget.play().catch(() => {})}
                        onMouseLeave={(event) => {
                          event.currentTarget.pause()
                          event.currentTarget.currentTime = 0
                        }}
                      />
                      <span className="absolute right-2 top-2 rounded-full bg-background/85 px-2 py-0.5 text-[10px] text-foreground backdrop-blur-sm">
                        {example.tag}
                      </span>
                    </span>
                    <span className="block px-3 pb-2.5 pt-2">
                      <span className="block text-xs font-medium text-foreground">
                        {example.title}
                      </span>
                      <span className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {example.prompt}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <CreationInspiration />
        )}
      </section>
      <section className="mx-auto max-w-6xl" aria-label={t('welcome.recent')}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('welcome.recent')}</h2>
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => useStore.getState().setAppMode('projects')}
          >
            {t('welcome.allProjects')}
          </button>
        </div>
        <ProjectGrid recent />
      </section>
    </main>
  )
}
