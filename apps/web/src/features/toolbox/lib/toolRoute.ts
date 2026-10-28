import { toolRouteSlug } from '../../../lib/appPaths'
import type { ToolId } from './tool'

/** 地址里的工具名。尺寸调整的内部 id 是历史名 `export`，地址用它在界面上的名字。 */
const TOOL_SLUGS: Record<ToolId, string> = {
  export: 'resize',
  compress: 'compress',
  convert: 'convert',
  crop: 'crop',
  rotate: 'rotate',
  collage: 'collage',
  stitch: 'stitch',
  slice: 'slice',
}

const BY_SLUG = new Map(
  Object.entries(TOOL_SLUGS).map(([id, slug]) => [slug, id as ToolId] as const),
)

/** 工具页的地址；没选工具时是目录 `/tools`。 */
export function toolPath(tool: ToolId | null): string {
  return tool ? `/tools/${TOOL_SLUGS[tool]}` : '/tools'
}

/** 地址对应的工具。目录、未知工具名与别的入口都返回 null（落到目录）。 */
export function toolFromPath(pathname: string): ToolId | null {
  const slug = toolRouteSlug(pathname)
  return slug ? (BY_SLUG.get(slug) ?? null) : null
}
