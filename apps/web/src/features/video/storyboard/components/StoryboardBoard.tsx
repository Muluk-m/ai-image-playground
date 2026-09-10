import { storyboardRangeLabel } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import Pending from '../../../../components/Pending'
import { useVideoStore } from '../../store'
import { STORYBOARD_PLAN_TYPICAL_SECONDS, useStoryboardStore } from '../store'
import type { StoryboardShotPatch, StoryboardShotRecord } from '../types'
import DirectorFrame from './DirectorFrame'
import DirectorGeneration from './DirectorGeneration'
import './director.css'

export default function StoryboardBoard({
  onLibrary = () => {},
  onSubmitted = () => {},
  generating = false,
}: {
  onLibrary?: () => void
  onSubmitted?: () => void
  generating?: boolean
}) {
  const storyboards = useStoryboardStore((s) => s.storyboards)
  const activeId = useStoryboardStore((s) => s.activeId)
  const loadingSince = useStoryboardStore((s) => s.loadingSince)
  const saveState = useStoryboardStore((s) => (activeId ? s.saveStates[activeId] : undefined))
  const [selected, setSelected] = useState<number | null>(null)
  const [panel, setPanel] = useState<'detail' | 'save' | 'versions' | 'generate'>('detail')
  const [scope, setScope] = useState<'whole' | 'shot'>('whole')
  const [name, setName] = useState('精修版')
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const record = storyboards.find((item) => item.id === activeId)
  const shot = record?.shots.find((item) => item.no === selected) ?? record?.shots[0]
  useEffect(() => {
    setSelected(null)
    setPreview(false)
  }, [activeId])
  useEffect(() => {
    if (generating) setPanel('generate')
  }, [generating, activeId])
  useEffect(() => {
    useVideoStore.getState().syncModelOptions()
  }, [])
  useEffect(() => {
    if (!preview || !record || !shot) return
    const timer = window.setTimeout(() => {
      const index = record.shots.findIndex((item) => item.no === shot.no)
      const next = record.shots[index + 1]
      if (next) setSelected(next.no)
      else setPreview(false)
    }, shot.seconds * 1000)
    return () => window.clearTimeout(timer)
  }, [preview, record, shot])
  if (!record)
    return (
      <div className="vd-empty">
        <h2>从一个故事开始</h2>
        <p>新建分镜，或从分镜库载入已有作品。</p>
        <button type="button" onClick={onLibrary}>
          打开分镜库
        </button>
      </div>
    )
  const store = useStoryboardStore.getState
  const patch = (field: keyof StoryboardShotPatch, value: string | number) => {
    if (shot) void store().updateShot(record.id, shot.no, { [field]: value })
  }
  const choose = (item: StoryboardShotRecord) => {
    setSelected(item.no)
    setPreview(false)
  }
  const index = record.shots.findIndex((item) => item.no === shot?.no)
  const save = async () => {
    setSaving(true)
    const version = await store().saveVersion(record.id, name)
    setSaving(false)
    if (version) setPanel('versions')
  }
  return (
    <section className="vd-project">
      <div className="vd-row vd-between vd-heading">
        <div>
          <small className="vd-muted">视频项目 / {record.style}风格</small>
          <h2>{record.title}</h2>
          <div className="vd-row vd-muted" aria-live="polite">
            <span>
              {saveState === 'error'
                ? '保存失败，更改尚未写入本机'
                : saveState === 'saving'
                  ? '正在保存…'
                  : '草稿已保存到本机'}
            </span>
            {saveState === 'error' && (
              <button type="button" onClick={() => void store().retrySave(record.id)}>
                重试保存
              </button>
            )}
          </div>
        </div>
        <div className="vd-row">
          <button type="button" onClick={() => setPanel('versions')}>
            版本记录
          </button>
          <button type="button" onClick={() => setPanel('save')}>
            保存版本
          </button>
          <button
            type="button"
            className="vd-primary"
            onClick={() => {
              setScope('whole')
              setPanel('generate')
            }}
          >
            生成视频
          </button>
        </div>
      </div>
      <div className="vd-layout">
        <aside className="vd-rail">
          <small className="vd-muted">
            {record.shots.length} 个镜头 · {record.totalSeconds} 秒
          </small>
          {record.shots.map((item, i) => (
            <button
              key={item.no}
              type="button"
              aria-pressed={shot?.no === item.no}
              aria-label={`选择镜头 ${i + 1}`}
              onClick={() => choose(item)}
            >
              <DirectorFrame shot={item} />
              <small>
                {String(i + 1).padStart(2, '0')} · {item.seconds}s
              </small>
              <span>{item.title}</span>
            </button>
          ))}
          <button type="button" onClick={() => void store().addShot(record.id)}>
            ＋ 添加镜头
          </button>
        </aside>
        <div className="vd-stage">
          {shot ? (
            <>
              <div className="vd-row vd-between">
                <h3>镜头 {index + 1}</h3>
                <small className="vd-muted">
                  {preview ? '分镜序列预览 · 静帧' : '分镜参考画面'} · {record.aspectRatio}
                </small>
              </div>
              <div className="vd-hero">
                <DirectorFrame shot={shot} />
              </div>
              <div className="vd-row vd-between">
                <h3>{shot.title}</h3>
                <span className="vd-muted">
                  {shot.camera} · {storyboardRangeLabel(shot)} 秒
                </span>
              </div>
              <p className="vd-muted">{shot.description}</p>
              <div className="vd-row">
                <button
                  type="button"
                  onClick={() => {
                    if (!preview) setSelected(record.shots[0]!.no)
                    setPreview(!preview)
                  }}
                >
                  {preview ? '暂停预览' : '预览分镜'}
                </button>
                <button
                  type="button"
                  onClick={() => void store().regenerateShotImage(record.id, shot.no)}
                >
                  {shot.imageId ? '重新生成分镜图' : '生成分镜图'}
                </button>
              </div>
              <div className="vd-divider" />
              <div className="vd-row vd-between">
                <h3>故事时间线</h3>
                <small className="vd-muted">{record.totalSeconds} 秒</small>
              </div>
              <div className="vd-timeline">
                {record.shots.map((item, i) => (
                  <button
                    key={item.no}
                    type="button"
                    aria-pressed={shot.no === item.no}
                    onClick={() => choose(item)}
                    style={{ flexGrow: item.seconds }}
                  >
                    <DirectorFrame shot={item} />
                    <small>
                      {i + 1} · {item.seconds}s
                    </small>
                  </button>
                ))}
              </div>
              <div className="vd-row">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => void store().moveShot(record.id, shot.no, -1)}
                >
                  ← 前移
                </button>
                <button
                  type="button"
                  disabled={index === record.shots.length - 1}
                  onClick={() => void store().moveShot(record.id, shot.no, 1)}
                >
                  后移 →
                </button>
              </div>
            </>
          ) : (
            <p>这份分镜还没有镜头，可以添加镜头或重写脚本。</p>
          )}
          <details>
            <summary>全片风格与高级提示词</summary>
            <p>{record.summary}</p>
            <label>
              整条视频提示词
              <textarea
                aria-label="整条视频提示词"
                value={record.videoPrompt}
                onChange={(e) => void store().updateVideoPrompt(record.id, e.target.value)}
                rows={6}
              />
            </label>
            <p className="vd-muted">编辑镜头内容或顺序后，会重新组织这里的镜头段落。</p>
          </details>
          <div className="vd-row">
            <button
              type="button"
              disabled={loadingSince !== null}
              onClick={() => void store().replan(record.id)}
            >
              {loadingSince === null ? (
                '重写脚本'
              ) : (
                <Pending label="生成中" startedAt={loadingSince} />
              )}
            </button>
            <button type="button" onClick={() => void store().generateMissingShotImages(record.id)}>
              补齐分镜图
            </button>
            <button type="button" onClick={() => void store().exportZip(record.id)}>
              导出分镜
            </button>
          </div>
          {loadingSince !== null && (
            <p className="vd-muted">通常 {STORYBOARD_PLAN_TYPICAL_SECONDS} 秒</p>
          )}
        </div>
        <aside className="vd-inspector">
          {panel === 'generate' ? (
            <DirectorGeneration
              key={`${record.id}-${scope}`}
              record={record}
              shot={shot}
              initialScope={scope}
              onClose={() => setPanel('detail')}
              onLibrary={onLibrary}
              onSubmitted={onSubmitted}
            />
          ) : panel === 'save' ? (
            <form
              className="vd-stack"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <h3>保存分镜版本</h3>
              <label>
                分镜名称
                <input
                  aria-label="分镜名称"
                  value={record.title}
                  onChange={(e) => void store().rename(record.id, e.target.value)}
                />
              </label>
              <label>
                版本名称
                <input
                  aria-label="版本名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p className="vd-muted">保存脚本、镜头顺序与参考画面，可在分镜库恢复。</p>
              <button type="submit" className="vd-primary" disabled={saving}>
                {saving ? '保存中…' : '保存新版本'}
              </button>
              <button type="button" onClick={() => setPanel('detail')}>
                返回编辑
              </button>
            </form>
          ) : panel === 'versions' ? (
            <div className="vd-stack">
              <div className="vd-row vd-between">
                <h3>版本记录</h3>
                <button type="button" onClick={() => setPanel('detail')}>
                  返回编辑
                </button>
              </div>
              {!record.versions?.length && <p>还没有命名版本。草稿已自动保存在本机。</p>}
              {[...(record.versions ?? [])].reverse().map((version) => (
                <div key={version.id} className="vd-inset">
                  <strong>
                    v{version.number} · {version.name}
                  </strong>
                  <p>
                    {new Date(version.savedAt).toLocaleString()} · {version.content.totalSeconds} 秒
                  </p>
                  <button
                    type="button"
                    onClick={() => void store().restoreVersion(record.id, version.id)}
                  >
                    恢复此版本
                  </button>
                </div>
              ))}
            </div>
          ) : shot ? (
            <div className="vd-stack">
              <h3>镜头详情</h3>
              <label>
                镜头名称
                <input
                  aria-label="镜头名称"
                  value={shot.title}
                  onChange={(e) => patch('title', e.target.value)}
                />
              </label>
              <label>
                画面描述
                <textarea
                  aria-label="画面描述"
                  value={shot.description}
                  onChange={(e) => patch('description', e.target.value)}
                  rows={4}
                />
              </label>
              <div className="vd-fields">
                <label>
                  运镜
                  <input
                    aria-label="运镜"
                    value={shot.camera}
                    onChange={(e) => patch('camera', e.target.value)}
                  />
                </label>
                <label>
                  时长 / 秒
                  <input
                    type="number"
                    min="0.5"
                    max="30"
                    step="0.5"
                    aria-label="镜头时长"
                    value={shot.seconds}
                    onChange={(e) => patch('seconds', Number(e.target.value))}
                  />
                </label>
              </div>
              <label>
                对白 / 声音
                <textarea
                  aria-label="对白"
                  value={shot.line}
                  onChange={(e) => patch('line', e.target.value)}
                  rows={2}
                />
              </label>
              <details>
                <summary>单镜头提示词</summary>
                <label>
                  图片提示词
                  <textarea
                    aria-label="图片提示词"
                    value={shot.imagePrompt}
                    onChange={(e) => patch('imagePrompt', e.target.value)}
                  />
                </label>
                <label>
                  视频提示词
                  <textarea
                    aria-label="视频提示词"
                    value={shot.videoPrompt}
                    onChange={(e) => patch('videoPrompt', e.target.value)}
                  />
                </label>
              </details>
              <button
                type="button"
                onClick={() => {
                  setScope('shot')
                  setPanel('generate')
                }}
              >
                仅生成当前镜头
              </button>
              <div className="vd-row">
                <button type="button" onClick={() => void store().addShot(record.id, shot.no)}>
                  复制镜头
                </button>
                <button
                  type="button"
                  disabled={record.shots.length === 1}
                  onClick={() => void store().removeShot(record.id, shot.no)}
                >
                  删除镜头
                </button>
              </div>
            </div>
          ) : (
            <p>先添加一个镜头</p>
          )}
        </aside>
      </div>
    </section>
  )
}
