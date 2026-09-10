import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { useVideoStore } from '../store'
import StoryboardBoard from '../storyboard/components/StoryboardBoard'
import StoryboardComposer from '../storyboard/components/StoryboardComposer'
import StoryboardLibrary from '../storyboard/components/StoryboardLibrary'
import { useStoryboardStore } from '../storyboard/store'
import VideoComposer from './VideoComposer'
import VideoFeed from './VideoFeed'

type View = 'director' | 'library' | 'results' | 'quick' | 'new'
export default function VideoMode() {
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
      <div className="video-director">
        <nav className="vd-nav" aria-label="视频工作区">
          <div className="vd-row">
            {enabled && (
              <>
                <button
                  type="button"
                  aria-pressed={view === 'director'}
                  onClick={() => open(false)}
                >
                  导演台
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'library'}
                  onClick={() => setView('library')}
                >
                  分镜库
                </button>
              </>
            )}
            <button
              type="button"
              aria-pressed={view === 'results'}
              onClick={() => setView('results')}
            >
              生成与成片
            </button>
            <button type="button" aria-pressed={view === 'quick'} onClick={() => setView('quick')}>
              快速生成
            </button>
          </div>
          {enabled && (
            <button type="button" onClick={() => setView('new')}>
              ＋ 新建分镜
            </button>
          )}
        </nav>
        {loadError && (
          <div className="vd-empty" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => void useStoryboardStore.getState().load()}>
              重新读取
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
              <h2>把故事变成一条影片</h2>
              <p>创建分镜后，在导演台里打磨画面、保存版本并生成视频。</p>
              <button type="button" className="vd-primary" onClick={() => setView('new')}>
                创建第一个分镜
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
            <h2>你的故事，从这里开始</h2>
            <p className="vd-muted">描述创意、添加参考图，再到导演台逐镜打磨。</p>
            {support ? <StoryboardComposer support={support} /> : <p>当前没有可用的视频模型</p>}
          </section>
        )}
      </div>
    </main>
  )
}
