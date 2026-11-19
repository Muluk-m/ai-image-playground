import assets from './site-assets.json'

/** 官网和教程媒体共用 ai-images；内容哈希允许长期缓存，工作台的本地副本保留。 */
export const SITE_ASSET_BASE = 'https://store.kaleidonova.com/muvloom/site/'
export const SITE_ASSETS: Readonly<Record<string, string>> = assets

export function siteAssetUrl(path: string): string {
  const key = SITE_ASSETS[path]
  if (!key) throw new Error(`官网素材未登记：${path}`)
  return `${SITE_ASSET_BASE}${key}`
}
