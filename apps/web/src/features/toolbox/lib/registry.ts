import { collageTool } from '../tools/collage'
import { compressTool } from '../tools/compress'
import { convertTool } from '../tools/convert'
import { cropTool } from '../tools/crop'
import { resizeTool } from '../tools/resize'
import { rotateTool } from '../tools/rotate'
import { sliceTool } from '../tools/slice'
import { stitchTool } from '../tools/stitch'
import type { ToolDefinition, ToolGroup } from './tool'

/**
 * 目录页照着这张表长：一件工具就是一个模块，卡片、参数行与处理逻辑都跟着它走，
 * 目录页和工具页都不用改。
 */
export const TOOLS: readonly ToolDefinition[] = [
  compressTool,
  convertTool,
  resizeTool,
  cropTool,
  rotateTool,
  collageTool,
  stitchTool,
  sliceTool,
]

/** 目录页的分组顺序。 */
export const TOOL_GROUPS: readonly ToolGroup[] = ['process', 'compose']
