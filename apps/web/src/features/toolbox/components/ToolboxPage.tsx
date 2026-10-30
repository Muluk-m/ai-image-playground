import ExportTool from '../../image-export/ExportTool'
import { TOOLS } from '../lib/registry'
import { useToolboxStore } from '../store'
import CombineView from './CombineView'
import RotateTool from './RotateTool'
import ToolCatalog from './ToolCatalog'
import ToolView from './ToolView'

/**
 * 「工具箱」入口：`/tools` 是目录，`/tools/<工具>` 是那件工具的工作台。
 * 按 id 挂 key，换工具是一次干净的 mount；导入的图在 store 里，换工具不丢。
 */
export default function ToolboxPage() {
  const activeTool = useToolboxStore((state) => state.activeTool)
  const tool = TOOLS.find((one) => one.id === activeTool)
  if (!tool) return <ToolCatalog />
  if (tool.id === 'rotate') return <RotateTool key={tool.id} />
  if (tool.kind === 'custom') return <ExportTool key={tool.id} />
  return tool.kind === 'each' ? (
    <ToolView key={tool.id} tool={tool} />
  ) : (
    <CombineView key={tool.id} tool={tool} />
  )
}
