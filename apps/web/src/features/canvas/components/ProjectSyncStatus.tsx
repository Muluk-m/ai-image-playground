import { useSyncExternalStore } from 'react'
import type { CloudProjectSession, ProjectSyncStatus } from '../lib/cloudProjects'

const labels: Record<ProjectSyncStatus, string> = {
  loading: '正在读取云端画布',
  pending: '画布等待同步',
  syncing: '画布正在同步',
  saved: '画布已同步',
  error: '画布同步失败',
  conflict: '画布同步冲突',
  'media-local': '画布尚未完整同步',
}
export default function ProjectSyncStatus({ session }: { session: CloudProjectSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return (
    <div
      className="pointer-events-auto max-w-sm text-xs text-muted-foreground"
      role={state.status === 'error' || state.status === 'conflict' ? 'alert' : 'status'}
    >
      <p>{labels[state.status]}</p>
      {state.message && <p className="mt-1">{state.message}</p>}
      {(state.status === 'error' || state.status === 'pending') && (
        <button
          type="button"
          className="ml-2 underline"
          onClick={() => void session.sync().catch(() => {})}
        >
          重试同步
        </button>
      )}
      {state.status === 'saved' && <small>草稿仅保存在此设备</small>}
    </div>
  )
}
