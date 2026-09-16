import { useAgentStore } from '../store'

export default function AgentHistoryStatus() {
  const loading = useAgentStore((state) => state.historyLoading)
  const failed = useAgentStore((state) => state.historyFailed)
  if (!loading && !failed) return null
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className="mx-1 rounded-xl border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
    >
      <p>{loading ? '正在加载对话…' : '对话暂时未能加载，项目和草稿已保留。'}</p>
      {failed && (
        <button
          type="button"
          className="mt-2 font-medium text-primary hover:underline"
          onClick={() => void useAgentStore.getState().retryHistory()}
        >
          重新加载
        </button>
      )}
    </div>
  )
}
