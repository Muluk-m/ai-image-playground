import { useEffect } from 'react'
import { useLibraryStore } from '../../library/store'
import { useVideoStore } from '../store'
import VideoComposer from './VideoComposer'
import VideoResultList from './VideoResultList'

export default function VideoMode() {
  useEffect(() => {
    void useVideoStore.getState().loadTasks()
    // 首尾帧可以从素材库挑，选图弹层要现成的素材记录。
    void useLibraryStore.getState().loadAssets()
  }, [])

  return (
    <main className="safe-area-x mx-auto max-w-7xl px-4 pb-24 pt-4">
      <div className="grid gap-4 lg:grid-cols-[23rem_minmax(0,1fr)]">
        <VideoComposer />
        <VideoResultList />
      </div>
    </main>
  )
}
