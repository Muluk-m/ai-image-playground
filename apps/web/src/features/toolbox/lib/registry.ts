import { compressTool } from '../tools/compress'
import type { ToolDefinition, ToolGroup } from './tool'

/**
 * 目录页照着这张表长：一件工具做完就加进来，卡片、参数行与处理逻辑都跟着它走，
 * 目录页和工具页都不用改。没做的工具不出现在目录里——摆一张点进去只有拖放区的卡片，
 * 等于把「还没做」做成了一个功能。
 */
export const TOOLS: readonly ToolDefinition[] = [compressTool]

/** 目录页的分组顺序。某一组一件工具都还没有时，那一段整块不渲染。 */
export const TOOL_GROUPS: readonly ToolGroup[] = ['process', 'compose']
