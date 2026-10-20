/**
 * 探索页的 9 个分组。只在前端归并 manifest 里的 category，不改数据。
 * 表里没有的分类落到「其他」，开发环境每种分类只警告一次。
 */
export const INSPIRATION_GROUPS = [
  {
    id: 'posters',
    name: '海报与字体',
    categories: ['海报与字体', 'YouTube 缩略图', '社交媒体帖子'],
  },
  {
    id: 'illustration',
    name: '插画与艺术',
    categories: ['插画与艺术', '漫画 / 故事板', '游戏素材', '历史与古典'],
  },
  {
    id: 'photo',
    name: '摄影与写实',
    categories: ['摄影与写实', '旅行照片玩法'],
  },
  {
    id: 'product',
    name: '产品与电商',
    categories: ['产品与电商', '电商主图', '产品营销'],
  },
  {
    id: 'people',
    name: '人物与头像',
    categories: ['人物与角色', '个人资料 / 头像'],
  },
  {
    id: 'scene',
    name: '场景与空间',
    categories: ['场景与叙事', '建筑与空间'],
  },
  {
    id: 'infographic',
    name: '信息图',
    categories: ['图表与信息图', '信息图 / 教育视觉图'],
  },
  {
    id: 'brand',
    name: '品牌与界面',
    categories: ['品牌与 Logo', 'UI 与界面'],
  },
  {
    id: 'other',
    name: '其他',
    categories: ['其他场景', '精选'],
  },
] as const

export type InspirationGroupId = (typeof INSPIRATION_GROUPS)[number]['id']

const CATEGORY_GROUP = new Map<string, InspirationGroupId>()
for (const group of INSPIRATION_GROUPS) {
  for (const category of group.categories) CATEGORY_GROUP.set(category, group.id)
}

const warnedCategories = new Set<string>()

export function groupOf(category: string): InspirationGroupId {
  const known = CATEGORY_GROUP.get(category)
  if (known) return known
  if (category && import.meta.env.DEV && !warnedCategories.has(category)) {
    warnedCategories.add(category)
    console.warn(`[inspiration] category “${category}” is not in a group; showing it under 其他`)
  }
  return 'other'
}

export function isInspirationGroupId(value: string | null): value is InspirationGroupId {
  return INSPIRATION_GROUPS.some((group) => group.id === value)
}
