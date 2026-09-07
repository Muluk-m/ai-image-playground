import { PROMPT_LANGUAGES, type ProductBox } from '@image-playground/shared'
import { useShallow } from 'zustand/react/shallow'
import Overlay from '../../../components/Overlay'
import {
  FIELD,
  GHOST_BUTTON,
  LABEL,
  OUTLINE_BUTTON,
  PRIMARY_BUTTON,
} from '../../../components/panelStyles'
import Segmented from '../../../components/Segmented'
import { actionLabel, PROMPT_LANGUAGE_LABELS } from '../lib/actions'
import { formatTextList, parseTextList } from '../lib/remixPlan'
import type { VersionPlanPatch } from '../lib/versionPlan'
import { useProductShotsStore } from '../store'
import type { ProductShotVersion } from '../types'
import TextField from './TextField'

const BADGE = 'rounded px-1.5 py-0.5 text-xs'
const NO_BOX = '方案没框出产品'
const BOX_SIDES: Array<{ key: keyof ProductBox; label: string }> = [
  { key: 'x', label: '产品框左' },
  { key: 'y', label: '产品框上' },
  { key: 'w', label: '产品框宽' },
  { key: 'h', label: '产品框高' },
]

export default function PlanDrawer() {
  const versionId = useProductShotsStore((s) => s.planVersionId)
  const version = useProductShotsStore(
    useShallow((s) =>
      s.draft.images.flatMap((image) => image.versions).find((item) => item.id === versionId),
    ),
  )
  const language = useProductShotsStore((s) => s.draft.language)
  const busy = useProductShotsStore((s) => s.swapStage !== null || s.batch?.running === true)

  const {
    closePlanDrawer,
    editVersionPlan,
    resetVersionPrompt,
    regenerateFromVersion,
    setPromptLanguage,
  } = useProductShotsStore.getState()

  if (!version) return null
  const edit = (patch: VersionPlanPatch) => editVersionPlan(version.id, patch)

  return (
    <Overlay onClose={closePlanDrawer} layout="fill">
      <div
        data-product-shots-plan-drawer
        className="fixed inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border border-gray-200/70 bg-white shadow-2xl animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[26rem] sm:rounded-none sm:rounded-l-2xl"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200/70 p-4 dark:border-white/[0.08]">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">方案</h3>
          <span className={`${BADGE} bg-violet-500/10 text-violet-700 dark:text-violet-300`}>
            {actionLabel(version.mode, version.level)}
          </span>
          {version.promptEdited && (
            <span className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-300`}>
              手改
            </span>
          )}
          <button type="button" onClick={closePlanDrawer} className={`ml-auto ${GHOST_BUTTON}`}>
            收起
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex items-center gap-2">
            <span className={LABEL}>文案语言</span>
            <Segmented
              label="文案语言"
              options={PROMPT_LANGUAGES}
              labels={PROMPT_LANGUAGE_LABELS}
              value={language}
              onChange={setPromptLanguage}
            />
          </div>

          {version.brief ? (
            <RemixBriefFields version={version} onEdit={edit} />
          ) : (
            <SwapPlanFields version={version} onEdit={edit} />
          )}

          <div>
            <div className="flex items-center gap-2">
              <span className={LABEL}>提示词</span>
              {version.promptEdited && (
                <button
                  type="button"
                  onClick={() => resetVersionPrompt(version.id)}
                  className={GHOST_BUTTON}
                >
                  重置为 AI 版本
                </button>
              )}
            </div>
            <textarea
              aria-label="提示词"
              value={version.prompt}
              rows={10}
              onChange={(e) => edit({ prompt: e.target.value })}
              className={`mt-1 ${FIELD} resize-y font-mono text-xs`}
            />
          </div>
        </div>

        <div className="flex gap-2 border-t border-gray-200/70 p-4 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={() => void regenerateFromVersion(version.id)}
            disabled={busy}
            className={PRIMARY_BUTTON}
          >
            按此重生成
          </button>
          <button type="button" onClick={closePlanDrawer} className={OUTLINE_BUTTON}>
            关闭
          </button>
        </div>
      </div>
    </Overlay>
  )
}

interface FieldsProps {
  version: ProductShotVersion
  onEdit: (patch: VersionPlanPatch) => void
}

function RemixBriefFields({ version, onEdit }: FieldsProps) {
  const brief = version.brief
  if (!brief) return null
  const copy = version.copy ?? { title: '', subtitle: '' }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField
        label="构图"
        value={brief.composition}
        onChange={(composition) => onEdit({ brief: { composition } })}
      />
      <TextField
        label="机位"
        value={brief.camera}
        onChange={(camera) => onEdit({ brief: { camera } })}
      />
      <TextField
        label="光线"
        value={brief.lighting}
        onChange={(lighting) => onEdit({ brief: { lighting } })}
      />
      <TextField
        label="背景"
        value={brief.background}
        onChange={(background) => onEdit({ brief: { background } })}
      />
      <TextField
        // 不受控，所以换版本时要靠 key 重挂。
        key={`props-${version.id}`}
        label="道具"
        defaultValue={formatTextList(brief.props)}
        onChange={(text) => onEdit({ brief: { props: parseTextList(text) } })}
      />
      <TextField
        key={`palette-${version.id}`}
        label="配色"
        defaultValue={formatTextList(brief.palette)}
        onChange={(text) => onEdit({ brief: { palette: parseTextList(text) } })}
      />
      <TextField
        label="标题"
        value={copy.title}
        onChange={(title) => onEdit({ copy: { title } })}
      />
      <TextField
        label="副标题"
        value={copy.subtitle}
        onChange={(subtitle) => onEdit({ copy: { subtitle } })}
      />
    </div>
  )
}

function SwapPlanFields({ version, onEdit }: FieldsProps) {
  const box = version.productBox

  return (
    <div className="flex flex-col gap-3">
      <div>
        <span className={LABEL}>方案句</span>
        <textarea
          aria-label="方案句"
          value={version.plan}
          rows={3}
          onChange={(e) => onEdit({ plan: e.target.value })}
          className={`mt-1 ${FIELD} resize-y`}
        />
      </div>
      <div>
        <span className={LABEL}>产品框</span>
        {box ? (
          <div className="mt-1 grid grid-cols-4 gap-2">
            {BOX_SIDES.map((side) => (
              <input
                key={`${side.key}-${version.id}`}
                type="number"
                step="0.01"
                min="0"
                max="1"
                aria-label={side.label}
                defaultValue={box[side.key]}
                onChange={(e) =>
                  onEdit({ productBox: { ...box, [side.key]: Number(e.target.value) } })
                }
                className={FIELD}
              />
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{NO_BOX}</p>
        )}
      </div>
    </div>
  )
}
