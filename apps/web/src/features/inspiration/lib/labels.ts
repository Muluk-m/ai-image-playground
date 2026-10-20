import { currentLocale } from '../../../i18n'
import { INSPIRATION_GROUPS, type InspirationGroupId } from './groups'

/**
 * 灵感库的分类和标签是清单里的中文数据，不随界面语言改写存储值。
 * 英文界面只在展示时查这张表；没有对应译文时原样显示。案例标题保持原文。
 */
const EN_FACETS: Record<string, string> = {
  海报与字体: 'Posters & type',
  'UI 与界面': 'UI & interfaces',
  摄影与写实: 'Photography & realism',
  图表与信息图: 'Charts & infographics',
  插画与艺术: 'Illustration & art',
  产品与电商: 'Product & commerce',
  其他场景: 'Other scenes',
  '品牌与 Logo': 'Brand & logo',
  电商主图: 'Commerce hero images',
  人物与角色: 'People & characters',
  '个人资料 / 头像': 'Profiles & avatars',
  'YouTube 缩略图': 'YouTube thumbnails',
  '漫画 / 故事板': 'Comics & storyboards',
  场景与叙事: 'Scenes & narrative',
  历史与古典: 'History & classical',
  '信息图 / 教育视觉图': 'Infographics & education',
  社交媒体帖子: 'Social posts',
  建筑与空间: 'Architecture & space',
  产品营销: 'Product marketing',
  文档与排版: 'Documents & layout',
  精选: 'Featured',
  游戏素材: 'Game assets',
  科技: 'Technology',
  商业: 'Business',
  写实: 'Realistic',
  海报: 'Poster',
  人物: 'People',
  插画: 'Illustration',
  时尚: 'Fashion',
  社交: 'Social',
  品牌: 'Brand',
  信息图: 'Infographic',
  产品: 'Product',
  故事: 'Story',
  创意: 'Creative',
  美食: 'Food',
  教育: 'Education',
  旅行: 'Travel',
  历史: 'History',
  古典: 'Classical',
  其他: 'Other',
  排版: 'Layout',
  文字: 'Lettering',
  摄影: 'Photography',
  建筑: 'Architecture',
  文档: 'Document',
  干净: 'Clean',
  图表: 'Chart',
  图生图: 'Image edit',
  电商: 'Commerce',
  场景: 'Scene',
  手绘: 'Hand-drawn',
  草图: 'Sketch',
  室内设计: 'Interior',
  文生图: 'Text to image',
  角色: 'Character',
  设定: 'Design sheet',
  叙事: 'Narrative',
  夜景: 'Night',
  复古: 'Retro',
}

const EN_GROUPS: Record<InspirationGroupId, string> = {
  posters: 'Posters & type',
  illustration: 'Illustration & art',
  photo: 'Photography & realism',
  product: 'Product & commerce',
  people: 'People & portraits',
  scene: 'Scenes & spaces',
  infographic: 'Infographics',
  brand: 'Brand & interface',
  other: 'Other',
}

export function inspirationFacetLabel(value: string, locale = currentLocale()): string {
  if (!locale.toLowerCase().startsWith('en')) return value
  return EN_FACETS[value] ?? value
}

/** 分组 id 或清单里的中文分组名。英文界面走固定译文，和 locale 文件一致。 */
export function inspirationGroupLabel(value: string, locale = currentLocale()): string {
  const group =
    INSPIRATION_GROUPS.find((entry) => entry.id === value) ??
    INSPIRATION_GROUPS.find((entry) => entry.name === value)
  if (!group) return inspirationFacetLabel(value, locale)
  if (!locale.toLowerCase().startsWith('en')) return group.name
  return EN_GROUPS[group.id]
}
