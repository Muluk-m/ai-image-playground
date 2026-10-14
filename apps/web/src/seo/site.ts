/** 首页 JSON-LD 与指南页共用的站点实体。名字与首页 `<title>`、og:site_name 一致。 */
export const SITE_NAME = '幕芽 Muvloom'
export const SITE_ALTERNATE_NAME = 'Muvloom'

/** 同一实体在各页用同一个绝对 id，搜索引擎才能把首页和指南对上。 */
export function siteEntityId(origin: string, entity: 'organization' | 'website' | 'app'): string {
  return `${origin}/#${entity}`
}
