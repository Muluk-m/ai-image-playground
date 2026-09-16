import { storyboardRangeLabel } from '@image-playground/shared'
import { useEffect, useState } from 'react'
import Pending from '../../../../components/Pending'
import { useTranslation } from '../../../../i18n'
import { formatDateTime } from '../../../../i18n/format'
import { useVideoStore } from '../../store'
import { STORYBOARD_PLAN_TYPICAL_SECONDS, useStoryboardStore } from '../store'
import { type StoryboardShotPatch, type StoryboardShotRecord, storyboardStyleLabel } from '../types'
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
  const { t } = useTranslation(['video', 'common'])
  const storyboards = useStoryboardStore((s) => s.storyboards)
  const activeId = useStoryboardStore((s) => s.activeId)
  const loadingSince = useStoryboardStore((s) => s.loadingSince)
  const saveState = useStoryboardStore((s) => (activeId ? s.saveStates[activeId] : undefined))
  const [selected, setSelected] = useState<number | null>(null)
  const [panel, setPanel] = useState<'detail' | 'save' | 'versions' | 'generate'>('detail')
  const [scope, setScope] = useState<'whole' | 'shot'>('whole')
  const [name, setName] = useState(() => t('board.defaultVersionName'))
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
        <h2>{t('board.emptyTitle')}</h2>
        <p>{t('board.emptyDescription')}</p>
        <button type="button" onClick={onLibrary}>
          {t('board.emptyAction')}
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
          <small className="vd-muted">
            {t('board.kicker', { style: storyboardStyleLabel(record.style) })}
          </small>
          <h2>{record.title}</h2>
          <div className="vd-row vd-muted" aria-live="polite">
            <span>
              {saveState === 'error'
                ? t('board.saveError')
                : saveState === 'saving'
                  ? t('board.saving')
                  : t('board.saved')}
            </span>
            {saveState === 'error' && (
              <button type="button" onClick={() => void store().retrySave(record.id)}>
                {t('board.retrySave')}
              </button>
            )}
          </div>
        </div>
        <div className="vd-row">
          <button type="button" onClick={() => setPanel('versions')}>
            {t('board.versionsTab')}
          </button>
          <button type="button" onClick={() => setPanel('save')}>
            {t('board.saveVersionTab')}
          </button>
          <button
            type="button"
            className="vd-primary"
            onClick={() => {
              setScope('whole')
              setPanel('generate')
            }}
          >
            {t('action.generateVideo')}
          </button>
        </div>
      </div>
      <div className="vd-layout">
        <aside className="vd-rail">
          <small className="vd-muted">
            {t('board.railSummary', {
              count: record.shots.length,
              seconds: record.totalSeconds,
            })}
          </small>
          {record.shots.map((item, i) => (
            <button
              key={item.no}
              type="button"
              aria-pressed={shot?.no === item.no}
              aria-label={t('board.selectShotAria', { index: i + 1 })}
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
            {t('board.addShot')}
          </button>
        </aside>
        <div className="vd-stage">
          {shot ? (
            <>
              <div className="vd-row vd-between">
                <h3>{t('board.shotHeading', { index: index + 1 })}</h3>
                <small className="vd-muted">
                  {t('board.stageMeta', {
                    mode: preview ? t('board.previewMode') : t('board.referenceMode'),
                    aspect: record.aspectRatio,
                  })}
                </small>
              </div>
              <div className="vd-hero">
                <DirectorFrame shot={shot} />
              </div>
              <div className="vd-row vd-between">
                <h3>{shot.title}</h3>
                <span className="vd-muted">
                  {t('board.shotMeta', { camera: shot.camera, range: storyboardRangeLabel(shot) })}
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
                  {preview ? t('board.pausePreview') : t('board.startPreview')}
                </button>
                <button
                  type="button"
                  onClick={() => void store().regenerateShotImage(record.id, shot.no)}
                >
                  {shot.imageId ? t('board.regenerateFrame') : t('board.generateFrame')}
                </button>
              </div>
              <div className="vd-divider" />
              <div className="vd-row vd-between">
                <h3>{t('board.timelineTitle')}</h3>
                <small className="vd-muted">
                  {t('shared.seconds', { seconds: record.totalSeconds })}
                </small>
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
                  {t('board.moveBack')}
                </button>
                <button
                  type="button"
                  disabled={index === record.shots.length - 1}
                  onClick={() => void store().moveShot(record.id, shot.no, 1)}
                >
                  {t('board.moveForward')}
                </button>
              </div>
            </>
          ) : (
            <p>{t('board.noShots')}</p>
          )}
          <details>
            <summary>{t('board.advancedSummary')}</summary>
            <p>{record.summary}</p>
            <label>
              {t('board.videoPromptLabel')}
              <textarea
                aria-label={t('board.videoPromptLabel')}
                value={record.videoPrompt}
                onChange={(e) => void store().updateVideoPrompt(record.id, e.target.value)}
                rows={6}
              />
            </label>
            <p className="vd-muted">{t('board.advancedNote')}</p>
          </details>
          <div className="vd-row">
            <button
              type="button"
              disabled={loadingSince !== null}
              onClick={() => void store().replan(record.id)}
            >
              {loadingSince === null ? (
                t('board.replan')
              ) : (
                <Pending label={t('common:state.generating')} startedAt={loadingSince} />
              )}
            </button>
            <button type="button" onClick={() => void store().generateMissingShotImages(record.id)}>
              {t('board.fillFrames')}
            </button>
            <button type="button" onClick={() => void store().exportZip(record.id)}>
              {t('board.export')}
            </button>
          </div>
          {loadingSince !== null && (
            <p className="vd-muted">
              {t('shared.typicalSeconds', { seconds: STORYBOARD_PLAN_TYPICAL_SECONDS })}
            </p>
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
              <h3>{t('board.saveVersionTitle')}</h3>
              <label>
                {t('board.boardNameLabel')}
                <input
                  aria-label={t('board.boardNameLabel')}
                  value={record.title}
                  onChange={(e) => void store().rename(record.id, e.target.value)}
                />
              </label>
              <label>
                {t('board.versionNameLabel')}
                <input
                  aria-label={t('board.versionNameLabel')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p className="vd-muted">{t('board.saveVersionNote')}</p>
              <button type="submit" className="vd-primary" disabled={saving}>
                {saving ? t('board.savingVersion') : t('board.saveNewVersion')}
              </button>
              <button type="button" onClick={() => setPanel('detail')}>
                {t('action.backToEdit')}
              </button>
            </form>
          ) : panel === 'versions' ? (
            <div className="vd-stack">
              <div className="vd-row vd-between">
                <h3>{t('board.versionsTab')}</h3>
                <button type="button" onClick={() => setPanel('detail')}>
                  {t('action.backToEdit')}
                </button>
              </div>
              {!record.versions?.length && <p>{t('board.noVersions')}</p>}
              {[...(record.versions ?? [])].reverse().map((version) => (
                <div key={version.id} className="vd-inset">
                  <strong>
                    v{version.number} · {version.name}
                  </strong>
                  <p>
                    {t('board.versionMeta', {
                      savedAt: formatDateTime(version.savedAt),
                      seconds: version.content.totalSeconds,
                    })}
                  </p>
                  <button
                    type="button"
                    onClick={() => void store().restoreVersion(record.id, version.id)}
                  >
                    {t('board.restoreVersion')}
                  </button>
                </div>
              ))}
            </div>
          ) : shot ? (
            <div className="vd-stack">
              <h3>{t('board.shotDetail')}</h3>
              <label>
                {t('board.shotNameLabel')}
                <input
                  aria-label={t('board.shotNameLabel')}
                  value={shot.title}
                  onChange={(e) => patch('title', e.target.value)}
                />
              </label>
              <label>
                {t('board.shotDescriptionLabel')}
                <textarea
                  aria-label={t('board.shotDescriptionLabel')}
                  value={shot.description}
                  onChange={(e) => patch('description', e.target.value)}
                  rows={4}
                />
              </label>
              <div className="vd-fields">
                <label>
                  {t('board.cameraLabel')}
                  <input
                    aria-label={t('board.cameraLabel')}
                    value={shot.camera}
                    onChange={(e) => patch('camera', e.target.value)}
                  />
                </label>
                <label>
                  {t('board.durationLabel')}
                  <input
                    type="number"
                    min="0.5"
                    max="30"
                    step="0.5"
                    aria-label={t('board.durationAria')}
                    value={shot.seconds}
                    onChange={(e) => patch('seconds', Number(e.target.value))}
                  />
                </label>
              </div>
              <label>
                {t('board.lineLabel')}
                <textarea
                  aria-label={t('board.lineAria')}
                  value={shot.line}
                  onChange={(e) => patch('line', e.target.value)}
                  rows={2}
                />
              </label>
              <details>
                <summary>{t('board.shotPromptsSummary')}</summary>
                <label>
                  {t('board.imagePromptLabel')}
                  <textarea
                    aria-label={t('board.imagePromptLabel')}
                    value={shot.imagePrompt}
                    onChange={(e) => patch('imagePrompt', e.target.value)}
                  />
                </label>
                <label>
                  {t('board.shotVideoPromptLabel')}
                  <textarea
                    aria-label={t('board.shotVideoPromptLabel')}
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
                {t('board.generateThisShot')}
              </button>
              <div className="vd-row">
                <button type="button" onClick={() => void store().addShot(record.id, shot.no)}>
                  {t('board.duplicateShot')}
                </button>
                <button
                  type="button"
                  disabled={record.shots.length === 1}
                  onClick={() => void store().removeShot(record.id, shot.no)}
                >
                  {t('board.removeShot')}
                </button>
              </div>
            </div>
          ) : (
            <p>{t('board.noShotSelected')}</p>
          )}
        </aside>
      </div>
    </section>
  )
}
