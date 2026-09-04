import { SHOT_TYPES, type ShotType } from '@image-playground/shared'
import AssetThumb from '../../library/components/AssetThumb'
import { isRenderableShotType } from '../lib/prompt'
import { canGenerateShot } from '../lib/shots'
import { useRemixStore } from '../store'
import { type RemixShot, SHOT_TYPE_LABELS } from '../types'
import BackgroundStylePicker from './BackgroundStylePicker'
import ListInput from './ListInput'
import { CARD, FIELD, LABEL, NOTICE, PRIMARY_BUTTON } from './styles'

const BADGE = 'rounded-full px-2 py-0.5 text-xs'
const THUMB = 'h-20 w-20 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]'

function Thumb({
  label,
  imageId,
  empty = '无',
}: {
  label: string
  imageId?: string
  empty?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {imageId ? (
        <div className={THUMB}>
          <AssetThumb imageId={imageId} alt={label} />
        </div>
      ) : (
        <div
          className={`${THUMB} flex items-center justify-center bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300`}
        >
          {empty}
        </div>
      )}
    </div>
  )
}

function BriefField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}) {
  return (
    <div>
      <span className={LABEL}>{label}</span>
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 ${FIELD}`}
      />
    </div>
  )
}

function ShotCard({ shot, index }: { shot: RemixShot; index: number }) {
  const updateShot = useRemixStore((s) => s.updateShot)
  const resetShotPrompt = useRemixStore((s) => s.resetShotPrompt)
  const own = useRemixStore((s) => s.draft.sourceKind === 'own')
  const renderable = isRenderableShotType(shot.type)
  const generatable = canGenerateShot(shot)

  return (
    <li className={`${CARD} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={shot.enabled}
          disabled={!generatable}
          aria-label={`第 ${index + 1} 镜`}
          onChange={(event) => updateShot(shot.id, { enabled: event.target.checked })}
          className="h-4 w-4 accent-blue-500 disabled:opacity-40"
        />
        <select
          value={shot.type}
          aria-label={`第 ${index + 1} 镜镜型`}
          onChange={(event) => updateShot(shot.id, { type: event.target.value as ShotType })}
          className={`${FIELD} w-auto`}
        >
          {SHOT_TYPES.map((type) => (
            <option key={type} value={type}>
              {SHOT_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        {!renderable && (
          <span className={`${BADGE} bg-gray-500/10 text-gray-600 dark:text-gray-300`}>不生图</span>
        )}
        {renderable && !shot.productImageId && (
          <span className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-300`}>
            缺底图
          </span>
        )}
        {shot.promptEdited && (
          <span className={`${BADGE} bg-blue-500/10 text-blue-700 dark:text-blue-300`}>
            已手动编辑
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <Thumb label={own ? '原图' : '竞品原图'} imageId={shot.sourceImageId} />
        {!own && <Thumb label="参考图" imageId={shot.referenceImageId} />}
        {!own && renderable && (
          <Thumb label="产品底图" imageId={shot.productImageId} empty="缺底图" />
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {!own && (
          <>
            <BriefField
              label="构图"
              value={shot.brief.composition}
              onChange={(composition) => updateShot(shot.id, { brief: { composition } })}
            />
            <BriefField
              label="机位"
              value={shot.brief.camera}
              onChange={(camera) => updateShot(shot.id, { brief: { camera } })}
            />
            <BriefField
              label="光线"
              value={shot.brief.lighting}
              onChange={(lighting) => updateShot(shot.id, { brief: { lighting } })}
            />
          </>
        )}
        <BriefField
          label="背景"
          value={shot.brief.background}
          onChange={(background) => updateShot(shot.id, { brief: { background } })}
        />
        <div>
          <span className={LABEL}>{own ? '配件' : '道具'}</span>
          <ListInput
            key={`${shot.id}-props`}
            label={own ? '配件' : '道具'}
            value={shot.brief.props}
            onChange={(props) => updateShot(shot.id, { brief: { props } })}
            className={`mt-1 ${FIELD}`}
          />
        </div>
        {!own && (
          <div>
            <span className={LABEL}>配色</span>
            <ListInput
              key={`${shot.id}-palette`}
              label="配色"
              value={shot.brief.palette}
              onChange={(palette) => updateShot(shot.id, { brief: { palette } })}
              className={`mt-1 ${FIELD}`}
            />
          </div>
        )}
        {shot.type === 'selling-point' && (
          <>
            <BriefField
              label="标题"
              value={shot.copy.title}
              onChange={(title) => updateShot(shot.id, { copy: { title } })}
            />
            <BriefField
              label="副标题"
              value={shot.copy.subtitle}
              onChange={(subtitle) => updateShot(shot.id, { copy: { subtitle } })}
            />
          </>
        )}
      </div>

      {renderable && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className={LABEL}>提示词</span>
            <button
              type="button"
              onClick={() => resetShotPrompt(shot.id)}
              className="rounded-lg px-2 py-1 text-xs text-blue-600 transition hover:bg-blue-500/10 dark:text-blue-300"
            >
              重新生成提示词
            </button>
          </div>
          <textarea
            aria-label={`第 ${index + 1} 镜提示词`}
            value={shot.prompt}
            rows={4}
            onChange={(event) => updateShot(shot.id, { prompt: event.target.value })}
            className={`${FIELD} resize-y`}
          />
        </div>
      )}
    </li>
  )
}

export default function RemixBriefStep() {
  const draft = useRemixStore((s) => s.draft)
  const analyzing = useRemixStore((s) => s.analyzing)
  const analyzeNotice = useRemixStore((s) => s.analyzeNotice)
  const analyzeShots = useRemixStore((s) => s.analyzeShots)
  const saveShotsAndContinue = useRemixStore((s) => s.saveShotsAndContinue)

  if (!draft.id) {
    return (
      <div className={`${CARD} text-center text-sm text-gray-500 dark:text-gray-400`}>
        先在步骤①保存一个套
      </div>
    )
  }

  const selected = draft.shots.filter((shot) => shot.enabled).length

  return (
    <div className="flex flex-col gap-4">
      {draft.sourceKind === 'own' ? (
        <BackgroundStylePicker />
      ) : (
        <div className={`${CARD} flex flex-wrap items-center gap-3`}>
          <button
            type="button"
            onClick={() => void analyzeShots()}
            disabled={analyzing}
            className={PRIMARY_BUTTON}
          >
            {analyzing ? '分析中' : draft.shots.length > 0 ? '重新分析' : '分析竞品图'}
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {draft.shots.length} 镜 · 已选 {selected} 镜
          </span>
          {analyzeNotice && <p className={`w-full ${NOTICE}`}>{analyzeNotice}</p>}
        </div>
      )}

      {draft.shots.length > 0 && (
        <ol className="flex flex-col gap-4">
          {draft.shots.map((shot, index) => (
            <ShotCard key={shot.id} shot={shot} index={index} />
          ))}
        </ol>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void saveShotsAndContinue()}
          className={`${PRIMARY_BUTTON} px-4 py-2`}
        >
          下一步
        </button>
      </div>
    </div>
  )
}
