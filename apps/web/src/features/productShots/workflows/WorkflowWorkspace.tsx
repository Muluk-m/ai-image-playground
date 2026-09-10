import type { ProductBox, PromptLanguage } from '@image-playground/shared'
import { useRef, useState } from 'react'
import {
  CARD,
  FIELD,
  GHOST_BUTTON,
  LABEL,
  OUTLINE_BUTTON,
  PRIMARY_BUTTON,
  SELECT,
} from '../../../components/panelStyles'
import { useStore } from '../../../store'
import VersionBar from '../components/VersionBar'
import { useProductShotsStore } from '../store'
import type { ProductShotVersion } from '../types'
import { KIT_FORMATS, type KitFormat, kitSpecs, type WorkflowSpec } from './plan'
import { downloadKit } from './render'
import {
  closeWorkflow,
  defaultWorkflowModel,
  openWorkflow,
  retryProductWorkflow,
  submitProductWorkflow,
  updateWorkflowTitle,
  useWorkflowEditor,
  type WorkflowSession,
  workflowModels,
} from './runtime'
import WorkflowImage from './WorkflowImage'

const DIRECTIONS = ['暖色石材', '北欧浅木', '自然日光']
const KINDS = { edit: '局部修改', kit: '做成一套', draft: '先看方案', refine: '精修成品' }
function report(error: unknown) {
  useStore.getState().showToast(error instanceof Error ? error.message : String(error), 'error')
}

export default function WorkflowWorkspace({ session }: { session: WorkflowSession }) {
  const draft = useProductShotsStore((s) => s.draft)
  const tasks = useStore((s) => s.tasks)
  const busy = useWorkflowEditor((s) => s.submitting)
  const previewId = useProductShotsStore((s) => s.previewVersionId)
  const [model, setModel] = useState(() => defaultWorkflowModel(session.kind))
  const [instruction, setInstruction] = useState(session.kind === 'draft' ? draft.preference : '')
  const [box, setBox] = useState<ProductBox | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const [split, setSplit] = useState(50)
  const [compare, setCompare] = useState<'slider' | 'side'>('slider')
  const [formats, setFormats] = useState<KitFormat[]>(['square', 'portrait', 'wide'])
  const [languages, setLanguages] = useState<PromptLanguage[]>(['zh'])
  const [titles, setTitles] = useState({ zh: '', en: '' })
  const [size, setSize] = useState('1536x1024')
  const [submitted, setSubmitted] = useState(Boolean(session.resultVersionId))
  const choices = workflowModels()
  const image = draft.images.find((i) => i.imageId === session.imageId)
  const parent = image?.versions.find((v) => v.id === session.versionId)
  const sourceTask = parent ? tasks.find((t) => t.id === parent.taskId) : undefined
  const sourceImageId =
    sourceTask?.outputImages[0] ?? (!session.versionId ? session.imageId : undefined)
  const related =
    image?.versions.filter(
      (v) =>
        v.workflow?.spec.kind === session.kind && v.workflow.sourceVersionId === session.versionId,
    ) ?? []
  const newest =
    related.find((v) => v.id === session.resultVersionId) ?? related[related.length - 1]
  const versions = related.filter((v) => v.workflow?.groupId === newest?.workflow?.groupId)
  const shown = versions.find((v) => v.id === previewId) ?? newest
  const result = shown ? tasks.find((t) => t.id === shown.taskId) : undefined
  const resultId = result?.status === 'done' ? result.outputImages[0] : undefined
  const selected = image?.chosenVersionId === shown?.id
  const launch = async () => {
    const specs: WorkflowSpec[] =
      session.kind === 'edit'
        ? box
          ? [{ kind: 'edit', box, instruction }]
          : []
        : session.kind === 'kit'
          ? kitSpecs(formats, languages, titles)
          : session.kind === 'draft'
            ? DIRECTIONS.map((direction) => ({ kind: 'draft' as const, direction, instruction }))
            : [{ kind: 'refine', size, instruction }]
    const previousIds = new Set(image?.versions.map((v) => v.id))
    try {
      await submitProductWorkflow(session, specs, model)
    } catch (error) {
      report(error)
    } finally {
      const current = useProductShotsStore.getState()
      if (
        current.draft.id === session.jobId &&
        current.draft.images
          .find((i) => i.imageId === session.imageId)
          ?.versions.some((v) => !previousIds.has(v.id))
      )
        setSubmitted(true)
    }
  }

  const download = async () => {
    const entries = versions.flatMap((version) => {
      const task = tasks.find((t) => t.id === version.taskId)
      return task?.status === 'done' && task.outputImages[0]
        ? [{ version, imageId: task.outputImages[0] }]
        : []
    })
    try {
      await downloadKit(draft.name, entries)
    } catch (error) {
      report(error)
    }
  }
  const localEdit = session.kind === 'edit' && !submitted
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    }
  }
  if (!image) return null
  return (
    <div className="grid min-w-0 gap-4 lg:col-span-2 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <section className={CARD}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              {KINDS[session.kind]}
            </h2>
            <button type="button" className={GHOST_BUTTON} onClick={closeWorkflow}>
              返回
            </button>
          </div>
          {session.kind === 'kit' && versions.length > 0 && submitted ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {versions.map((version) => (
                <KitResult key={version.id} session={session} version={version} />
              ))}
            </div>
          ) : submitted && resultId && session.kind === 'edit' ? (
            <>
              <div
                className={
                  compare === 'side'
                    ? 'grid grid-cols-2 gap-2'
                    : 'relative overflow-hidden rounded-lg'
                }
              >
                <WorkflowImage
                  imageId={shown?.workflow?.sourceImageId ?? sourceImageId}
                  alt="修改前"
                />
                <div
                  className={compare === 'side' ? '' : 'absolute inset-0'}
                  style={compare === 'slider' ? { clipPath: `inset(0 0 0 ${split}%)` } : undefined}
                >
                  <WorkflowImage
                    imageId={resultId}
                    version={shown}
                    alt="修改后"
                    className="h-full w-full rounded-lg object-contain"
                  />
                </div>
                {compare === 'slider' && (
                  <span
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
                    style={{ left: `${split}%` }}
                  />
                )}
              </div>
              <div className="mt-2 flex justify-between text-xs text-gray-500">
                <span>修改前</span>
                <span>修改后</span>
              </div>
              {compare === 'slider' && (
                <input
                  aria-label="前后对比位置"
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  onChange={(e) => setSplit(Number(e.target.value))}
                  className="mt-2 w-full accent-blue-500"
                />
              )}
            </>
          ) : (
            <div
              className={`relative overflow-hidden rounded-lg ${localEdit ? 'cursor-crosshair touch-none' : ''}`}
              onPointerDown={(event) => {
                if (!localEdit) return
                event.preventDefault()
                start.current = point(event)
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                if (!start.current || !localEdit) return
                const end = point(event)
                setBox({
                  x: Math.min(start.current.x, end.x),
                  y: Math.min(start.current.y, end.y),
                  w: Math.abs(start.current.x - end.x),
                  h: Math.abs(start.current.y - end.y),
                })
              }}
              onPointerUp={() => {
                start.current = null
              }}
              onPointerCancel={() => {
                start.current = null
              }}
            >
              <WorkflowImage
                imageId={submitted && resultId ? resultId : sourceImageId}
                version={submitted && resultId ? shown : parent}
                alt={submitted && resultId ? '生成结果' : '来源图片'}
              />
              {localEdit && box && (
                <div
                  className="pointer-events-none absolute border-2 border-blue-500 bg-blue-500/20"
                  style={{
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.w * 100}%`,
                    height: `${box.h * 100}%`,
                  }}
                />
              )}
            </div>
          )}
          {submitted && result?.status === 'running' && (
            <p className="mt-3 text-sm text-blue-500">生成中，可继续查看其他版本</p>
          )}
          {submitted && result?.status === 'error' && (
            <p role="alert" className="mt-3 text-sm text-red-500">
              {result.error}
            </p>
          )}
          {session.kind === 'draft' && versions.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {versions.map((version) => {
                const task = tasks.find((t) => t.id === version.taskId)
                return (
                  <button
                    key={version.id}
                    type="button"
                    aria-pressed={shown?.id === version.id}
                    className={`rounded-lg border p-1 text-left text-xs ${shown?.id === version.id ? 'border-blue-500' : 'border-gray-200 dark:border-gray-700'}`}
                    onClick={() => {
                      setSubmitted(true)
                      useProductShotsStore.getState().previewVersion(version.id)
                    }}
                  >
                    <WorkflowImage imageId={task?.outputImages[0]} alt={version.plan} />
                    <span className="mt-1 block text-gray-700 dark:text-gray-200">
                      {version.plan}
                    </span>
                    {task?.status === 'error' && <span className="text-red-500">生成失败</span>}
                  </button>
                )
              })}
            </div>
          )}
        </section>
        <VersionBar />
      </div>
      <aside className={`${CARD} flex h-fit flex-col gap-3`}>
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          {submitted && resultId ? '确认结果' : '设置'}
        </h2>
        {(!submitted || session.kind === 'kit') && (
          <>
            <label className={LABEL}>
              生成模型
              <select
                className={`${SELECT} mt-1 w-full`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {session.kind === 'kit' ? (
              <>
                <span className={LABEL}>需要哪些图</span>
                {(Object.keys(KIT_FORMATS) as KitFormat[]).map((format) => (
                  <label
                    key={format}
                    className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
                  >
                    <input
                      type="checkbox"
                      checked={formats.includes(format)}
                      onChange={(e) =>
                        setFormats(
                          e.target.checked
                            ? [...formats, format]
                            : formats.filter((f) => f !== format),
                        )
                      }
                    />
                    {KIT_FORMATS[format].label}{' '}
                    <span className="text-xs text-gray-500">{KIT_FORMATS[format].size}</span>
                  </label>
                ))}
                <span className={LABEL}>图上文字</span>
                {(['zh', 'en'] as const).map((language) => (
                  <div key={language}>
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                      <input
                        type="checkbox"
                        checked={languages.includes(language)}
                        onChange={(e) =>
                          setLanguages(
                            e.target.checked
                              ? [...languages, language]
                              : languages.filter((l) => l !== language),
                          )
                        }
                      />
                      {language === 'zh' ? '中文' : '英文'}
                    </label>
                    {languages.includes(language) && (
                      <input
                        className={`${FIELD} mt-2`}
                        aria-label={`${language === 'zh' ? '中文' : '英文'}标题`}
                        maxLength={120}
                        placeholder="标题（可空）"
                        value={titles[language]}
                        onChange={(e) => setTitles({ ...titles, [language]: e.target.value })}
                      />
                    )}
                  </div>
                ))}
              </>
            ) : (
              <label className={LABEL}>
                {session.kind === 'edit'
                  ? '怎么改'
                  : session.kind === 'draft'
                    ? '偏好（可空）'
                    : '还想调整什么（可空）'}
                <textarea
                  className={`${FIELD} mt-1 min-h-24`}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={
                    session.kind === 'edit'
                      ? '例：去掉右边绿植，补齐墙面'
                      : '例：柔和日光，保持浴缸形状'
                  }
                />
              </label>
            )}
            {session.kind === 'edit' && (
              <>
                <p className={LABEL}>在图上拖动框选修改区域。框外也可能变化，请对比确认。</p>
                <button type="button" className={GHOST_BUTTON} onClick={() => setBox(null)}>
                  清除框选
                </button>
              </>
            )}
            {session.kind === 'refine' && (
              <label className={LABEL}>
                成品尺寸
                <select
                  className={`${SELECT} mt-1 w-full`}
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                >
                  {Object.values(KIT_FORMATS).map((f) => (
                    <option key={f.size}>{f.size}</option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={
                busy ||
                !sourceImageId ||
                !model ||
                (session.kind === 'edit' &&
                  (!box || box.w < 0.005 || box.h < 0.005 || !instruction.trim())) ||
                (session.kind === 'kit' && (!formats.length || !languages.length))
              }
              onClick={() => void launch()}
            >
              {busy
                ? '提交中'
                : session.kind === 'kit'
                  ? `生成 ${formats.length * languages.length} 张`
                  : session.kind === 'draft'
                    ? '先出 3 个方案'
                    : session.kind === 'refine'
                      ? '精修选中方案'
                      : '生成修改版'}
            </button>
          </>
        )}
        {submitted && session.kind === 'edit' && resultId && (
          <>
            <div className="flex gap-2">
              <button type="button" className={OUTLINE_BUTTON} onClick={() => setCompare('slider')}>
                滑动对比
              </button>
              <button type="button" className={OUTLINE_BUTTON} onClick={() => setCompare('side')}>
                并排对比
              </button>
            </div>
            <button
              type="button"
              className={OUTLINE_BUTTON}
              onClick={() => {
                if (shown) openWorkflow('edit', shown.id)
              }}
            >
              继续修改
            </button>
          </>
        )}
        {submitted && resultId && shown && session.kind === 'draft' && (
          <button
            type="button"
            className={PRIMARY_BUTTON}
            onClick={() => openWorkflow('refine', shown.id)}
          >
            精修选中方案
          </button>
        )}
        {submitted && resultId && shown && session.kind !== 'kit' && session.kind !== 'draft' && (
          <>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              onClick={() => useProductShotsStore.getState().chooseVersion(shown.id)}
            >
              {selected ? '已选用' : '用这版'}
            </button>
            <button
              type="button"
              className={OUTLINE_BUTTON}
              onClick={() => openWorkflow('kit', shown.id)}
            >
              做成一套
            </button>
          </>
        )}
        {submitted && result?.status === 'error' && shown && (
          <button
            type="button"
            disabled={busy}
            className={OUTLINE_BUTTON}
            onClick={() => void retryProductWorkflow(session, shown).catch(report)}
          >
            重试这张
          </button>
        )}
        {submitted && session.kind === 'kit' && versions.length > 0 && (
          <button type="button" className={OUTLINE_BUTTON} onClick={() => void download()}>
            打包下载已完成图片
          </button>
        )}
        <button type="button" className={GHOST_BUTTON} onClick={closeWorkflow}>
          返回商品图
        </button>
      </aside>
    </div>
  )
}

export function KitResult({
  session,
  version,
}: {
  session: WorkflowSession
  version: ProductShotVersion
}) {
  const task = useStore((s) => s.tasks.find((t) => t.id === version.taskId))
  const busy = useWorkflowEditor((s) => s.submitting)
  const [editing, setEditing] = useState(false)
  const savedTitle = version.workflow?.spec.kind === 'kit' ? version.workflow.spec.title : ''
  const [titleDraft, setTitleDraft] = useState({ base: savedTitle, value: savedTitle })
  const title = titleDraft.base === savedTitle ? titleDraft.value : savedTitle
  return (
    <article className="rounded-xl border border-gray-200 p-2 dark:border-gray-700">
      <WorkflowImage imageId={task?.outputImages[0]} version={version} alt={version.plan} />
      <h3 className="mt-2 text-xs font-medium text-gray-800 dark:text-gray-100">{version.plan}</h3>
      {task?.status === 'running' && <p className={LABEL}>生成中</p>}
      {task?.status === 'error' && <p className="text-xs text-red-500">{task.error}</p>}
      <div className="mt-2 flex flex-wrap gap-1">
        <button type="button" className={GHOST_BUTTON} onClick={() => setEditing(!editing)}>
          改文字
        </button>
        <button
          type="button"
          className={GHOST_BUTTON}
          disabled={busy || task?.status === 'running'}
          onClick={() => void retryProductWorkflow(session, version).catch(report)}
        >
          重做这张
        </button>
        <button
          type="button"
          className={GHOST_BUTTON}
          disabled={task?.status !== 'done'}
          onClick={() => {
            useProductShotsStore.getState().selectImage(session.imageId)
            openWorkflow('edit', version.id)
          }}
        >
          只改这里
        </button>
      </div>
      {editing && (
        <div className="mt-2">
          <input
            aria-label="标题"
            className={FIELD}
            value={title}
            maxLength={120}
            onChange={(e) => setTitleDraft({ base: savedTitle, value: e.target.value })}
          />
          <button
            type="button"
            className={`${PRIMARY_BUTTON} mt-2`}
            onClick={() =>
              void updateWorkflowTitle(session, version, title)
                .then(() => setEditing(false))
                .catch(report)
            }
          >
            保存文字
          </button>
        </div>
      )}
    </article>
  )
}
