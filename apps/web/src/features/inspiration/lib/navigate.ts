import { useStore } from '../../../store'
import { useInspirationStore } from '../store'

/** 灵感住在「探索」入口，不是浮层：所有「看灵感」的入口都落到那一页。 */
export function openInspiration(): void {
  useStore.getState().setAppMode('explore')
  void useInspirationStore.getState().loadRemote()
}

/** 当前是否正停在探索页。 */
export function onInspirationPage(): boolean {
  return useStore.getState().appMode === 'explore'
}
