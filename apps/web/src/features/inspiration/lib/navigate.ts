import { useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { useInspirationStore } from '../store'

/** 灵感是「库」里的一个页签，不是浮层：所有「看灵感」的入口都落到这一页。 */
export function openInspiration(): void {
  useLibraryStore.getState().setTab('inspiration')
  useStore.getState().setAppMode('library')
  void useInspirationStore.getState().loadRemote()
}

/** 当前是否正停在灵感页。 */
export function onInspirationPage(): boolean {
  return (
    useStore.getState().appMode === 'library' && useLibraryStore.getState().tab === 'inspiration'
  )
}
