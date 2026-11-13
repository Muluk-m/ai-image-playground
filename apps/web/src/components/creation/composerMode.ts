import type { AgentMode } from '@image-playground/shared'
import type { CreationMode } from './draft'

/** 与 store.createTarget 同一组值，决定作曲器显示哪种创作档。 */
export type ComposerCreateTarget = 'generate' | 'chat' | 'canvas' | 'video'

/**
 * 作曲器 UI 档。`agent | image | video` 是给选择器和文案看的；
 * 发给服务端、用于选工具和计价路径的是 `AgentMode`（`image | video`）。
 * 两套枚举只在这里转换，避免把 `agent` 当成协议模式送出去。
 */
export function creationModeOf(
  createTarget: ComposerCreateTarget,
  options: { readonly inline?: boolean } = {},
): CreationMode {
  // 工作台非 inline 的 InputBar 只做出图档，哪怕 createTarget 仍是 chat/video。
  if (options.inline === false) return 'image'
  if (createTarget === 'video') return 'video'
  if (createTarget === 'generate') return 'image'
  return 'agent'
}

export function agentModeOf(
  creationMode: CreationMode,
  options: { readonly production?: boolean; readonly videoAvailable?: boolean } = {},
): AgentMode {
  if (options.production) return 'video'
  if (options.videoAvailable === false) return 'image'
  return creationMode === 'video' ? 'video' : 'image'
}
