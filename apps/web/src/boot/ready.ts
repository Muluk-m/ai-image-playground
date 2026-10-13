import { BOOT_READY_EVENT } from './constants'

let signaled = false

/** 芽的闪屏一直盖到工作台或故障页画出来，再淡出。重复调用（含 StrictMode）只发一次。 */
export function signalBootReady(): void {
  if (signaled) return
  signaled = true
  document.dispatchEvent(new Event(BOOT_READY_EVENT))
}
