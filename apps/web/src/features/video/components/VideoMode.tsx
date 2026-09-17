import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { isVideoTaskActive } from '../lib/feed'
import { useVideoStore } from '../store'
import StoryboardBoard from '../storyboard/components/StoryboardBoard'
import StoryboardComposer from '../storyboard/components/StoryboardComposer'
import StoryboardLibrary from '../storyboard/components/StoryboardLibrary'
import { useStoryboardStore } from '../storyboard/store'
import VideoComposer from './VideoComposer'
import VideoFeed from './VideoFeed'

type View = 'director' | 'library' | 'results' | 'quick' | 'new'
export default function VideoMode() {
  const { t } = useTranslation('video')
  const enabled = isClientCapabilityEnabled('generation:storyboard')
  const [view, setView] = useState<View>(enabled ? 'director' : 'quick')
  const [generate, setGenerate] = useState(false)
  const imageTasks = useStore((s) => s.tasks)
  const storyboards = useStoryboardStore((s) => s.storyboards)
  useEffect(() => {
    useStoryboardStore
      .getState()
      .adoptShotImages(new Map(imageTasks.map((task) => [task.id, task])))
  }, [imageTasks, storyboards])
  const activeId = useStoryboardStore((s) => s.activeId)
  const loadError = useStoryboardStore((s) => s.loadError)
  const model = useVideoStore((s) => s.draft.model)
  const support = VIDEO_MODEL_SUPPORT[model]
  // 结果流只挂在两个视图下，切走就连同在跑的任务一起卸载。跑着的活得在每个视图都有入口。
  const runningCount = useVideoStore((s) => s.tasks.filter(isVideoTaskActive).length)
  const showRunning = runningCount > 0 && view !== 'results' && view !== 'quick'
  useEffect(() => {
    void useVideoStore.getState().loadTasks()
    void useStoryboardStore.getState().load()
    void useLibraryStore.getState().loadAssets()
  }, [])
  useEffect(() => {
    if (activeId && enabled) setView('director')
  }, [activeId, enabled])
  const open = (generating: boolean) => {
    setGenerate(generating)
    setView('director')
  }
  return (
    <main className="safe-area-x mx-auto max-w-[1500px] px-4 pb-24 pt-4">
      {showRunning && (
        <button
          type="button"
          aria-label={t('mode.viewRunningAria')}
          onClick={() => setView('results')}
          className="mb-3 flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-left text-sm text-foreground transition hover:border-primary"
        >
          <span>{t('mode.runningCount', { count: runningCount })}</span>
          <span className="text-xs text-muted-foreground">{t('mode.viewProgress')}</span>
        </button>
      )}
      <div className="video-director">
        <nav className="vd-nav" aria-label={t('mode.navLabel')}>
          <div className="vd-row">
            {enabled && (
              <>
                <button
                  type="button"
                  aria-pressed={view === 'director'}
                  onClick={() => open(false)}
                >
                  {t('mode.tabDirector')}
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'library'}
                  onClick={() => setView('library')}
                >
                  {t('mode.tabLibrary')}
                </button>
              </>
            )}
            <button
              type="button"
              aria-pressed={view === 'results'}
              onClick={() => setView('results')}
            >
              {t('mode.tabResults')}
            </button>
            <button type="button" aria-pressed={view === 'quick'} onClick={() => setView('quick')}>
              {t('mode.tabQuick')}
            </button>
          </div>
          {enabled && (
            <button type="button" onClick={() => setView('new')}>
              {t('action.newStoryboard')}
            </button>
          )}
        </nav>
        {loadError && (
          <div className="vd-empty" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => void useStoryboardStore.getState().load()}>
              {t('mode.reload')}
            </button>
          </div>
        )}
        {view === 'director' &&
          (activeId ? (
            <StoryboardBoard
              onLibrary={() => setView('library')}
              onSubmitted={() => setView('results')}
              generating={generate}
            />
          ) : (
            <div className="vd-empty">
              <h2>{t('mode.emptyTitle')}</h2>
              <p>{t('mode.emptyDescription')}</p>
              <button type="button" className="vd-primary" onClick={() => setView('new')}>
                {t('mode.emptyAction')}
              </button>
            </div>
          ))}
        {view === 'library' && <StoryboardLibrary onOpen={open} onNew={() => setView('new')} />}
        {view === 'results' && (
          <div className="vd-project">
            <VideoFeed />
          </div>
        )}
        {view === 'quick' && (
          <div className="grid gap-6 p-6 lg:grid-cols-[23rem_minmax(0,1fr)]">
            <VideoComposer />
            <VideoFeed />
          </div>
        )}
        {view === 'new' && (
          <section className="vd-new">
            <h2>{t('mode.newTitle')}</h2>
            <p className="vd-muted">{t('mode.newDescription')}</p>
            {support ? <StoryboardComposer support={support} /> : <p>{t('mode.noModel')}</p>}
          </section>
        )}
      </div>
    </main>
  )
}
