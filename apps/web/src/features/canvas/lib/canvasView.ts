import type { AgentSurface } from '@image-playground/shared'
import { useSyncExternalStore } from 'react'

/**
 * 项目此刻停在画布视图还是对话视图。发话时按它告诉服务端这一轮是画布模式还是 Agent 模式：
 * 只有画布视图里说的话才拿得到节点工具与画布上下文，对话视图里一律只生图、改图（不论项目入口是什么）。
 */
let shown: { readonly projectId: string; readonly view: 'chat' | 'canvas' } | null = null
const listeners = new Set<() => void>()

export function setProjectView(projectId: string | null, view: 'chat' | 'canvas' = 'chat') {
  const next = projectId ? { projectId, view } : null
  if (next?.projectId === shown?.projectId && next?.view === shown?.view) return
  shown = next
  for (const listener of listeners) listener()
}

/**
 * 工作区卸载或换视图时撤下自己写的那份。只在此刻的值仍是这次写下的项目与视图时才清空：
 * 换项目时旧工作区的清理可能晚于新工作区写入，不能把新项目的视图一并抹掉。
 */
export function clearProjectView(projectId: string, view: 'chat' | 'canvas') {
  if (shown?.projectId !== projectId || shown.view !== view) return
  shown = null
  for (const listener of listeners) listener()
}

/**
 * 这个项目这一轮按哪种模式说话。视图还没挂上（首屏刚建项目就发第一句）时按项目打开后的默认视图算，
 * 也就是它的入口：画布入口默认画布视图。
 */
export function currentAgentSurface(
  projectId: string | undefined,
  defaultView: 'chat' | 'canvas',
): AgentSurface {
  if (!projectId) return 'agent'
  const view = shown?.projectId === projectId ? shown.view : defaultView
  return view === 'canvas' ? 'canvas' : 'agent'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 此刻屏幕上这个项目的模式；`/` 菜单按它取技能清单，画布技能只在画布视图里出现。
 * 和发话时一样按项目隔离：记下的视图不属于这个项目（刚切项目、新工作区还没写入）时，
 * 按这个项目的默认视图算，不会沿用上一个项目的模式。
 */
export function useShownAgentSurface(
  projectId: string | undefined,
  defaultView: 'chat' | 'canvas',
): AgentSurface {
  return useSyncExternalStore(
    subscribe,
    () => currentAgentSurface(projectId, defaultView),
    () => 'agent',
  )
}
