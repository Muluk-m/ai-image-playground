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
  const records = useStoryboardStore((s) => s.storyboards)
  const open = (id: string, generate: boolean) => {
    useStoryboardStore.getState().select(id)
    onOpen(generate)
  }
  return (
    <section className="vd-project vd-stack">
      <div className="vd-row vd-between">
        <div>
          <h2>我的分镜</h2>
          <p className="vd-muted">保存在当前浏览器，可载入编辑或直接生成视频</p>
        </div>
        <button type="button" className="vd-primary" onClick={onNew}>
          ＋ 新建分镜
        </button>
      </div>
      {records.length === 0 ? (
        <div className="vd-empty">
          <p>还没有分镜，先创建你的第一个故事。</p>
          <button type="button" onClick={onNew}>
            新建分镜
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
                  {record.shots.length} 镜头 · {record.totalSeconds} 秒 · {record.aspectRatio}
                </small>
                <small>
                  {record.versions?.length ?? 0} 个保存版本 ·{' '}
                  {new Date(record.updatedAt).toLocaleDateString()}
                </small>
                <div className="vd-row">
                  <button type="button" onClick={() => open(record.id, false)}>
                    载入编辑
                  </button>
                  <button
                    type="button"
                    className="vd-primary"
                    onClick={() => open(record.id, true)}
                  >
                    生成视频
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    useStore.getState().setConfirmDialog({
                      title: '删除分镜',
                      message: `将删除「${record.title}」及其保存版本。已生成视频和任务来源快照会保留。`,
                      action: () => {
                        void useStoryboardStore.getState().remove(record.id)
                      },
                    })
                  }
                >
                  删除分镜
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
