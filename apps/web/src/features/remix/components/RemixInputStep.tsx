import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CloseIcon } from '../../../components/icons'
import AssetThumb from '../../library/components/AssetThumb'
import { useLibraryStore } from '../../library/store'
import { selectNeedsFrontAsset, useRemixStore } from '../store'
import {
  PRODUCT_ANGLE_LABELS,
  PRODUCT_ANGLES,
  type ProductAngle,
  REMIX_LANGUAGE_LABELS,
  REMIX_LANGUAGES,
  REMIX_LEVEL_LABELS,
  REMIX_LEVELS,
  REMIX_PLATFORM_LABELS,
  REMIX_PLATFORMS,
} from '../types'
import ListInput from './ListInput'
import { CARD, FIELD, LABEL, NOTICE, PRIMARY_BUTTON } from './styles'

function Choice<T extends string>({
  options,
  labels,
  value,
  onPick,
}: {
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onPick: (next: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onPick(option)}
          aria-pressed={value === option}
          className={`rounded-lg px-2.5 py-1 text-sm transition ${
            value === option
              ? 'bg-blue-500/10 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'
          }`}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  )
}

export default function RemixInputStep() {
  const draft = useRemixStore((s) => s.draft)
  const listingLoading = useRemixStore((s) => s.listingLoading)
  const listingNotice = useRemixStore((s) => s.listingNotice)
  const needsFrontAsset = useRemixStore(selectNeedsFrontAsset)
  const assets = useLibraryStore(
    useShallow((s) => [...s.assets].sort((a, b) => b.lastUsedAt - a.lastUsedAt)),
  )
  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
    setName,
    setListingUrl,
    fetchListing,
    importCompetitorFiles,
    removeCompetitorImage,
    toggleProductAsset,
    setProductAngle,
    updateSettings,
    updateProduct,
    saveAndContinue,
  } = useRemixStore.getState()

  const productDescription = draft.settings.product

  const angleOf = (assetId: string): ProductAngle | null =>
    draft.productAssets.find((product) => product.assetId === assetId)?.angle ?? null

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <label className={LABEL} htmlFor="remix-set-name">
          套名称
        </label>
        <input
          id="remix-set-name"
          value={draft.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：奶油浴缸"
          className={`mt-1.5 ${FIELD} sm:max-w-sm`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={CARD}>
          <h2 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-100">竞品图</h2>

          <label className={LABEL} htmlFor="remix-listing-url">
            竞品链接
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="remix-listing-url"
              value={draft.listingUrl}
              onChange={(e) => setListingUrl(e.target.value)}
              placeholder="https://www.amazon.com/dp/..."
              className={FIELD}
            />
            <button
              type="button"
              onClick={() => void fetchListing()}
              disabled={listingLoading}
              className={`shrink-0 ${PRIMARY_BUTTON}`}
            >
              {listingLoading ? '抓取中' : '抓取图集'}
            </button>
          </div>

          {listingNotice && <p className={`mt-2 ${NOTICE}`}>{listingNotice}</p>}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:border-blue-400 hover:text-blue-600 dark:border-white/[0.12] dark:text-gray-200 dark:hover:border-blue-500/50 dark:hover:text-blue-300"
            >
              上传竞品图
            </button>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {draft.competitorImageIds.length} 张
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void importCompetitorFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </div>

          {draft.competitorImageIds.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {draft.competitorImageIds.map((imageId, index) => (
                <li
                  key={imageId}
                  className="relative h-20 w-20 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]"
                >
                  <AssetThumb imageId={imageId} alt={`竞品图 ${index + 1}`} />
                  <button
                    type="button"
                    onClick={() => removeCompetitorImage(imageId)}
                    aria-label={`移除竞品图 ${index + 1}`}
                    className="absolute right-1 top-1 rounded-full bg-black/45 p-1 text-white transition hover:bg-black/65"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={CARD}>
          <h2 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-100">产品素材</h2>

          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="remix-product-name">
                产品名
              </label>
              <input
                id="remix-product-name"
                value={productDescription.name}
                onChange={(e) => updateProduct({ name: e.target.value })}
                placeholder="例：W2753 独立浴缸"
                className={`mt-1.5 ${FIELD}`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="remix-product-features">
                外形特征
              </label>
              <input
                id="remix-product-features"
                value={productDescription.features}
                onChange={(e) => updateProduct({ features: e.target.value })}
                placeholder="例：蛋形单边斜背，外沿薄壁"
                className={`mt-1.5 ${FIELD}`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="remix-product-color">
                主色
              </label>
              <input
                id="remix-product-color"
                value={productDescription.mainColor}
                onChange={(e) => updateProduct({ mainColor: e.target.value })}
                placeholder="例：哑光灰棕（暖调中灰偏棕）"
                className={`mt-1.5 ${FIELD}`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="remix-product-forbidden">
                禁止色
              </label>
              <ListInput
                key={`${draft.id ?? 'new'}-forbidden`}
                id="remix-product-forbidden"
                label="禁止色"
                value={productDescription.forbiddenColors}
                onChange={(forbiddenColors) => updateProduct({ forbiddenColors })}
                placeholder="例：米白、浅灰、白色、橄榄绿"
                className={`mt-1.5 ${FIELD}`}
              />
            </div>
          </div>

          {assets.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">素材库还是空的</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {assets.map((asset) => {
                const angle = angleOf(asset.id)
                return (
                  <li key={asset.id} className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => toggleProductAsset(asset.id)}
                      aria-pressed={angle !== null}
                      className={`overflow-hidden rounded-xl border transition ${
                        angle !== null
                          ? 'border-blue-400 ring-2 ring-blue-400/30'
                          : 'border-gray-200 hover:border-blue-300 dark:border-white/[0.08]'
                      }`}
                    >
                      <span className="block aspect-square">
                        <AssetThumb imageId={asset.imageId} alt={asset.name} />
                      </span>
                      <span className="block truncate px-2 py-1 text-xs text-gray-700 dark:text-gray-200">
                        {asset.name}
                      </span>
                    </button>
                    {angle !== null && (
                      <select
                        value={angle}
                        data-angle-for={asset.id}
                        aria-label={`${asset.name} 角度`}
                        onChange={(e) => setProductAngle(asset.id, e.target.value as ProductAngle)}
                        className={FIELD}
                      >
                        {PRODUCT_ANGLES.map((option) => (
                          <option key={option} value={option}>
                            {PRODUCT_ANGLE_LABELS[option]}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {needsFrontAsset && <p className={`mt-3 ${NOTICE}`}>建议补一张正面白底图</p>}
        </section>
      </div>

      <section className={`${CARD} grid gap-3 sm:grid-cols-3`}>
        <div>
          <span className={LABEL}>平台</span>
          <div className="mt-1.5">
            <Choice
              options={REMIX_PLATFORMS}
              labels={REMIX_PLATFORM_LABELS}
              value={draft.settings.platform}
              onPick={(platform) => updateSettings({ platform })}
            />
          </div>
        </div>
        <div>
          <span className={LABEL}>图上文案</span>
          <div className="mt-1.5">
            <Choice
              options={REMIX_LANGUAGES}
              labels={REMIX_LANGUAGE_LABELS}
              value={draft.settings.language}
              onPick={(language) => updateSettings({ language })}
            />
          </div>
        </div>
        <div>
          <span className={LABEL}>差异化档位</span>
          <div className="mt-1.5">
            <Choice
              options={REMIX_LEVELS}
              labels={REMIX_LEVEL_LABELS}
              value={draft.settings.level}
              onPick={(level) => updateSettings({ level })}
            />
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void saveAndContinue()}
          className={`${PRIMARY_BUTTON} px-4 py-2`}
        >
          保存并下一步
        </button>
      </div>
    </div>
  )
}
