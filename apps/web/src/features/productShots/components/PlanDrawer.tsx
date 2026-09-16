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
import { useTranslation } from '../../../i18n'
import { actionLabel, promptLanguageLabels } from '../lib/actions'
import { changesBackground } from '../lib/mode'
import { formatTextList, parseTextList } from '../lib/remixPlan'
import type { VersionPlanPatch } from '../lib/versionPlan'
import { useProductShotsStore } from '../store'
import type { ProductShotVersion } from '../types'
import PlanInventory from './PlanInventory'
import PlanReferences from './PlanReferences'
import TextField from './TextField'

const BADGE = 'rounded px-1.5 py-0.5 text-xs'
const BOX_SIDES = [
  { key: 'x', labelKey: 'plan.box.x' },
  { key: 'y', labelKey: 'plan.box.y' },
  { key: 'w', labelKey: 'plan.box.w' },
  { key: 'h', labelKey: 'plan.box.h' },
] as const satisfies ReadonlyArray<{ key: keyof ProductBox; labelKey: string }>

export default function PlanDrawer() {
  const { t } = useTranslation(['productShots', 'common'])
  const versionId = useProductShotsStore((s) => s.planVersionId)
  const found = useProductShotsStore(
    useShallow((s) => {
      for (const image of s.draft.images) {
        const version = image.versions.find((item) => item.id === versionId)
        if (version) return { imageId: image.imageId, version }
      }
      return null
    }),
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

  if (!found) return null
  const { imageId, version } = found
  const edit = (patch: VersionPlanPatch) => editVersionPlan(version.id, patch)

  return (
    <Overlay onClose={closePlanDrawer} layout="fill">
      <div
        data-product-shots-plan-drawer
        className="fixed inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border border-gray-200/70 bg-white shadow-2xl animate-modal-in dark:border-white/[0.08] dark:bg-gray-900 sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[26rem] sm:rounded-none sm:rounded-l-2xl"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200/70 p-4 dark:border-white/[0.08]">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {t('plan.title')}
          </h3>
          <span className={`${BADGE} bg-violet-500/10 text-violet-700 dark:text-violet-300`}>
            {actionLabel(version.mode, version.level)}
          </span>
          {version.promptEdited && (
            <span className={`${BADGE} bg-amber-500/10 text-amber-700 dark:text-amber-300`}>
              {t('tag.edited')}
            </span>
          )}
          <button type="button" onClick={closePlanDrawer} className={`ml-auto ${GHOST_BUTTON}`}>
            {t('common:action.collapse')}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <PlanReferences imageId={imageId} version={version} />

          <div className="flex items-center gap-2">
            <span className={LABEL}>{t('plan.textLanguage')}</span>
            <Segmented
              label={t('plan.textLanguage')}
              options={PROMPT_LANGUAGES}
              labels={promptLanguageLabels()}
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
              <span className={LABEL}>{t('plan.prompt')}</span>
              {version.promptEdited && (
                <button
                  type="button"
                  onClick={() => resetVersionPrompt(version.id)}
                  className={GHOST_BUTTON}
                >
                  {t('plan.resetPrompt')}
                </button>
              )}
            </div>
            <textarea
              aria-label={t('plan.prompt')}
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
            {t('plan.regenerate')}
          </button>
          <button type="button" onClick={closePlanDrawer} className={OUTLINE_BUTTON}>
            {t('common:action.close')}
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
  const { t } = useTranslation('productShots')
  const brief = version.brief
  if (!brief) return null
  const copy = version.copy ?? { title: '', subtitle: '' }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField
        label={t('plan.field.composition')}
        value={brief.composition}
        onChange={(composition) => onEdit({ brief: { composition } })}
      />
      <TextField
        label={t('plan.field.camera')}
        value={brief.camera}
        onChange={(camera) => onEdit({ brief: { camera } })}
      />
      <TextField
        label={t('plan.field.lighting')}
        value={brief.lighting}
        onChange={(lighting) => onEdit({ brief: { lighting } })}
      />
      <TextField
        label={t('plan.field.background')}
        value={brief.background}
        onChange={(background) => onEdit({ brief: { background } })}
      />
      <TextField
        // 不受控，所以换版本时要靠 key 重挂。
        key={`props-${version.id}`}
        label={t('plan.field.props')}
        defaultValue={formatTextList(brief.props)}
        onChange={(text) => onEdit({ brief: { props: parseTextList(text) } })}
      />
      <TextField
        key={`palette-${version.id}`}
        label={t('plan.field.palette')}
        defaultValue={formatTextList(brief.palette)}
        onChange={(text) => onEdit({ brief: { palette: parseTextList(text) } })}
      />
      <TextField
        label={t('plan.field.title')}
        value={copy.title}
        onChange={(title) => onEdit({ copy: { title } })}
      />
      <TextField
        label={t('plan.field.subtitle')}
        value={copy.subtitle}
        onChange={(subtitle) => onEdit({ copy: { subtitle } })}
      />
    </div>
  )
}

function SwapPlanFields({ version, onEdit }: FieldsProps) {
  const { t } = useTranslation('productShots')
  const box = version.productBox

  return (
    <div className="flex flex-col gap-3">
      {/* 只换产品那一版背景一个像素都不动，清单与方案句都进不了它的提示词，摆出来就是骗人。 */}
      {changesBackground(version.mode) && (
        <>
          <PlanInventory
            // 输入框里的草稿是本地 state，换版本要靠 key 清掉。
            key={version.id}
            inventory={version.inventory ?? []}
            onChange={(inventory) => onEdit({ inventory })}
          />
          <div>
            <span className={LABEL}>{t('plan.sentence')}</span>
            <textarea
              aria-label={t('plan.sentence')}
              value={version.plan}
              rows={3}
              onChange={(e) => onEdit({ plan: e.target.value })}
              className={`mt-1 ${FIELD} resize-y`}
            />
          </div>
        </>
      )}
      <div>
        <span className={LABEL}>{t('plan.productBox')}</span>
        {box ? (
          <div className="mt-1 grid grid-cols-4 gap-2">
            {BOX_SIDES.map((side) => (
              <input
                key={`${side.key}-${version.id}`}
                type="number"
                step="0.01"
                min="0"
                max="1"
                aria-label={t(side.labelKey)}
                defaultValue={box[side.key]}
                onChange={(e) =>
                  onEdit({ productBox: { ...box, [side.key]: Number(e.target.value) } })
                }
                className={FIELD}
              />
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{t('plan.noBox')}</p>
        )}
      </div>
    </div>
  )
}
