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

function shownSurface(): AgentSurface {
  return shown?.view === 'canvas' ? 'canvas' : 'agent'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 此刻屏幕上的模式；`/` 菜单按它取技能清单，画布技能只在画布视图里出现。 */
export function useShownAgentSurface(): AgentSurface {
  return useSyncExternalStore(subscribe, shownSurface, () => 'agent')
}
