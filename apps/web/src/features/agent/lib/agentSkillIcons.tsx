import { DEFAULT_AGENT_SKILL_ICON } from '@image-playground/shared'
import {
  Aperture,
  Brush,
  Clapperboard,
  Flame,
  Focus,
  ImagePlay,
  ImagePlus,
  Images,
  Languages,
  LayoutTemplate,
  type LucideIcon,
  Megaphone,
  Mountain,
  PackagePlus,
  Palette,
  PersonStanding,
  Replace,
  ScanSearch,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Sprout,
  WandSparkles,
  Waves,
} from 'lucide-react'

/**
 * 技能图标的**唯一一张表**：`meta.json` 里的 kebab-case 名字 → lucide 组件。
 *
 * 必须是静态 import。`lucide-react` 那套「按名字动态取组件」的写法会让打包器放弃摇树，
 * 把三千多个图标整包塞进产物——为了 13 个图标不值得。
 *
 * 新加技能就往这里加一行：`apps/web/src/__tests__/features/agent/lib/agentSkillIcons.test.ts`
 * 直接读 `apps/bff/skills/**\/meta.json`，漏了就会红。
 */
const AGENT_SKILL_ICONS: Readonly<Record<string, LucideIcon>> = {
  aperture: Aperture,
  brush: Brush,
  clapperboard: Clapperboard,
  flame: Flame,
  focus: Focus,
  'image-play': ImagePlay,
  'image-plus': ImagePlus,
  images: Images,
  languages: Languages,
  'layout-template': LayoutTemplate,
  megaphone: Megaphone,
  mountain: Mountain,
  'package-plus': PackagePlus,
  palette: Palette,
  'person-standing': PersonStanding,
  replace: Replace,
  'scan-search': ScanSearch,
  'shopping-bag': ShoppingBag,
  'shopping-cart': ShoppingCart,
  sparkles: Sparkles,
  sprout: Sprout,
  'wand-sparkles': WandSparkles,
  waves: Waves,
}

/** 白名单里认得的全部图标名，给测试对着技能目录点名。 */
export const AGENT_SKILL_ICON_NAMES: readonly string[] = Object.keys(AGENT_SKILL_ICONS)

/** 认不出的名字回退到默认图标——部署里的技能可能比这份前端新，不能因此渲染成空白。 */
export function agentSkillIcon(name: string | undefined): LucideIcon {
  return AGENT_SKILL_ICONS[name ?? ''] ?? AGENT_SKILL_ICONS[DEFAULT_AGENT_SKILL_ICON] ?? Sparkles
}

/** 技能图标。`/` 菜单、面板上的技能步骤都用它，保证同一条技能到哪儿都是同一个图标。 */
export default function AgentSkillIcon({
  name,
  className = 'h-4 w-4',
}: {
  readonly name: string | undefined
  readonly className?: string
}) {
  const Icon = agentSkillIcon(name)
  return <Icon className={className} aria-hidden="true" data-skill-icon={name || undefined} />
}
