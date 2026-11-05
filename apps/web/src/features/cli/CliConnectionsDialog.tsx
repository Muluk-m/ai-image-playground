import { useEffect, useRef } from 'react'
import { CLI_CONNECT_PATH } from '../../lib/appPaths'
import { navigate } from '../../lib/pathname'

/**
 * 宿主面仍导出这个名字。公开菜单已经直接去 `/connect`。收费 overlay 若还把它当弹层打开，
 * 这里也不再画对话框，而是进入同一页：安装引导和已连接设备都在那里。
 */
export default function CliConnectionsDialog({ onClose }: { onClose: () => void }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    close.current()
    navigate(CLI_CONNECT_PATH)
  }, [])
  return null
}
