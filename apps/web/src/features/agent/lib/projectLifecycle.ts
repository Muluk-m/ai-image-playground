import { canvasSceneKey, currentCanvasWorkspace } from '../../canvas/lib/workspaces'
import { currentCanvasProject } from '../../canvas/projectStore'
import { agentDraft, type DraftSession } from './drafts'

/**
 * 当前项目此刻用的那份草稿。项目身份决定草稿归属，会话 id 只用来接住项目化之前
 * 留下的旧草稿，所以推导只有这一处，输入框与项目切换读的必须是同一个会话。
 */
export function currentProjectDraft(conversationId: string | null): DraftSession {
  const project = currentCanvasProject()
  return agentDraft(conversationId, project?.id, project?.sceneKey === canvasSceneKey(null))
}

export type SaveCurrentProjectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'draft_save_failed' | 'save_failed' }

/**
 * 把当前项目未保存的输入与画布都落盘；任一半没落下就不算保存成功，调用方只看这一个结果。
 * 只停在 `CanvasWorkspace.flush()` 这一层：云同步由它代为触发，再往下探会出现两个主人。
 */
export async function saveCurrentProject(
  conversationId: string | null,
): Promise<SaveCurrentProjectResult> {
  // 顺序沿用 #416 的原实现，仓库里没有留下理由；草稿只写本机，画布的 flush() 会捎带触发云同步。
  const draft = currentProjectDraft(conversationId)
  await draft.ready
  // 草稿的 flush 不返回成败，写失败记在 snapshot 上。
  await draft.flush()
  if (draft.getSnapshot().error) return { ok: false, reason: 'draft_save_failed' }
  const workspace = currentCanvasWorkspace()
  // 读失败的画布 flush() 一定是 false，等 ready 只是为了不抢在首次读取前写。
  await workspace.ready.catch(() => {})
  // 画布的 flush 反过来：不抛，直接返回成败。
  if (!(await workspace.flush())) return { ok: false, reason: 'save_failed' }
  return { ok: true }
}
