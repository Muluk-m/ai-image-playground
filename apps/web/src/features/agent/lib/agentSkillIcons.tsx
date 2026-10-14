import { DEFAULT_AGENT_SKILL_ICON } from '@image-playground/shared'
import { Icon, type IconName } from '../../../components/ui/icon'

/** 技能协议里的 kebab-case 名字映射到设计系统语义名，保持旧技能目录兼容。 */
const AGENT_SKILL_ICONS: Readonly<Record<string, IconName>> = {
  aperture: 'aperture',
  brush: 'brush',
  camera: 'camera',
  clapperboard: 'storyboard',
  flame: 'flame',
  focus: 'focus',
  house: 'home',
  'image-play': 'imageAnimate',
  'image-plus': 'imageAdd',
  images: 'images',
  languages: 'translate',
  'layout-template': 'layoutTemplate',
  megaphone: 'advertise',
  mountain: 'landscape',
  notebook: 'notebook',
  'notebook-pen': 'notebook',
  'package-plus': 'productAdd',
  palette: 'palette',
  'person-standing': 'character',
  replace: 'replace',
  'scan-search': 'imageInspect',
  shapes: 'shape',
  'shopping-bag': 'product',
  'shopping-cart': 'cart',
  sparkles: 'generate',
  sprout: 'sprout',
  'wand-sparkles': 'wand',
  waves: 'waves',
  'zoom-in': 'zoomIn',
}

/** 白名单里认得的全部图标名，给测试对着技能目录点名。 */
export const AGENT_SKILL_ICON_NAMES: readonly string[] = Object.keys(AGENT_SKILL_ICONS)

/** 认不出的名字回退到默认图标——部署里的技能可能比这份前端新，不能因此渲染成空白。 */
export function agentSkillIcon(name: string | undefined): IconName {
  return AGENT_SKILL_ICONS[name ?? ''] ?? AGENT_SKILL_ICONS[DEFAULT_AGENT_SKILL_ICON] ?? 'generate'
}

/** 技能图标。`/` 菜单、面板上的技能步骤都用它，保证同一条技能到哪儿都是同一个图标。 */
export default function AgentSkillIcon({
  name,
  className = 'h-4 w-4',
}: {
  readonly name: string | undefined
  readonly className?: string
}) {
  return (
    <span className="inline-flex shrink-0" data-skill-icon={name || undefined}>
      <Icon name={agentSkillIcon(name)} className={className} />
    </span>
  )
}
