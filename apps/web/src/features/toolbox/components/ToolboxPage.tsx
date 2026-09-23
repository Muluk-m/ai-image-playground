import { TOOLS } from '../lib/registry'
import { useToolboxStore } from '../store'
import ToolCatalog from './ToolCatalog'
import ToolView from './ToolView'

/** 「工具箱」入口：没选工具时是目录，选了就是那件工具的页面。按 id 挂 key，换工具是一次干净的 mount。 */
export default function ToolboxPage() {
  const activeTool = useToolboxStore((state) => state.activeTool)
  const tool = TOOLS.find((one) => one.id === activeTool)
  return tool ? <ToolView key={tool.id} tool={tool} /> : <ToolCatalog />
}
