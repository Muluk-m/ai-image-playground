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
  REMIX_SOURCE_KIND_LABELS,
  REMIX_SOURCE_KINDS,
} from '../types'
import ListInput from './ListInput'
import { CARD, FIELD, LABEL, NOTICE, OUTLINE_BUTTON, PRIMARY_BUTTON } from './styles'

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
  const productInputRef = useRef<HTMLInputElement>(null)

  const {
    setName,
    setListingUrl,
    fetchListing,
    importSourceFiles,
    removeSourceImage,
    toggleProductAsset,
    setProductAngle,
    updateSettings,
    updateProduct,
    saveAndContinue,
    setSourceKind,
    addSourceImages,
    importProductFiles,
  } = useRemixStore.getState()

  const productDescription = draft.settings.product
  const own = draft.sourceKind === 'own'

  const angleOf = (assetId: string): ProductAngle | null =>
    draft.productAssets.find((product) => product.assetId === assetId)?.angle ?? null

  return (
    <div className="flex flex-col gap-4">
      <div className={`${CARD} grid gap-3 sm:grid-cols-2`}>
        <div>
          <label className={LABEL} htmlFor="remix-set-name">
            套名称
          </label>
          <input
            id="remix-set-name"
            value={draft.name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：新品套图"
            className={`mt-1.5 ${FIELD}`}
          />
        </div>
        <div>
          <span className={LABEL}>来源</span>
          <div className="mt-1.5">
            <Choice
              options={REMIX_SOURCE_KINDS}
              labels={REMIX_SOURCE_KIND_LABELS}
              value={draft.sourceKind}
              onPick={setSourceKind}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={CARD}>
          <h2 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {own ? '原图' : '竞品图'}
          </h2>

          {!own && (
            <>
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
            </>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={OUTLINE_BUTTON}
            >
              {own ? '上传原图' : '上传竞品图'}
            </button>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {draft.sourceImageIds.length} 张
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              aria-label={own ? '上传原图' : '上传竞品图'}
              onChange={(e) => {
                void importSourceFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </div>

          {own && assets.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <button
                    type="button"
                    onClick={() => addSourceImages([asset.imageId])}
                    aria-label={`把 ${asset.name} 加为原图`}
                    className="h-16 w-16 overflow-hidden rounded-xl border border-gray-200 transition hover:border-blue-400 dark:border-white/[0.08]"
                  >
                    <AssetThumb imageId={asset.imageId} alt={asset.name} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {draft.sourceImageIds.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {draft.sourceImageIds.map((imageId, index) => (
                <li
                  key={imageId}
                  className="relative h-20 w-20 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]"
                >
                  <AssetThumb imageId={imageId} alt={`${own ? '原图' : '竞品图'} ${index + 1}`} />
                  <button
                    type="button"
                    onClick={() => removeSourceImage(imageId)}
                    aria-label={`移除${own ? '原图' : '竞品图'} ${index + 1}`}
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
                placeholder="例：产品型号或名称"
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
                placeholder="例：主体形状、边缘、材质"
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
                placeholder="例：主色，含冷暖倾向"
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
                placeholder="例：容易被误画成的颜色"
                className={`mt-1.5 ${FIELD}`}
              />
            </div>
          </div>

          {!own && (
            <div className="mb-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => productInputRef.current?.click()}
                className={OUTLINE_BUTTON}
              >
                上传产品图
              </button>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                已选 {draft.productAssets.length} 张
              </span>
              <input
                ref={productInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                aria-label="上传产品图"
                onChange={(e) => {
                  void importProductFiles([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </div>
          )}

          {!own && assets.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">素材库还是空的</p>
          )}
          {!own && assets.length > 0 && (
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

          {!own && needsFrontAsset && <p className={`mt-3 ${NOTICE}`}>建议补一张正面白底图</p>}
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
        {!own && (
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
        )}
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
