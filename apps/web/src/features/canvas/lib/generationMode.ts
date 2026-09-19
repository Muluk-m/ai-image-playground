import type { AgentMode } from '@image-playground/shared'
import { isVideoModeAvailable } from '../../../lib/channels/videoChannels'
import { useStore } from '../../../store'

/**
 * 生成类型由**入口**决定，不给用户一个可切的开关：创作入口只出图，视频入口只出视频。
 *
 * 之前输入框里有个图片 / 视频切换，于是「我在哪个入口」和「这一轮生成什么」是两件事，
 * 在视频入口里还能发图片轮，两个状态互相打架且没人说得清当前算哪种。现在只有一个来源。
 *
 * 部署没有视频能力（纯静态、或没有视频 channel）时一律算图片档：服务端那时本来就把视频轮
 * 当图片轮装配，报成视频只会骗人。
 */
export function generationMode(): AgentMode {
  return isVideoModeAvailable() && useStore.getState().appMode === 'video' ? 'video' : 'image'
}

/** 组件里用的版本：入口一变就重渲染。 */
export function useGenerationMode(): AgentMode {
  const appMode = useStore((state) => state.appMode)
  return isVideoModeAvailable() && appMode === 'video' ? 'video' : 'image'
}
