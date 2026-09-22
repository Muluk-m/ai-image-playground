import { useStore } from '../../../store'
import { agentPanelPresent } from '../panelLayout'
import { useAgentStore } from '../store'
import { fillAgentComposer } from './composerFill'
import { type AgentDraft, draftForSubmit } from './references'

/** 画布的生成栏要等切过去挂上才能接话；挂载在下一帧到几帧之间，最多等这么久。 */
async function fillWhenMounted(text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (fillAgentComposer(text)) return true
    // apps/web 的 lib target 还没到 es2024，这里用不了 Promise.withResolvers。
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * 首屏「画布」档的发送：新建一个画布项目、切过去，把首屏输入框里的话和参考图作为第一轮发出去。
 * 输入框只在服务端收下之后才清空——发失败了那句话还在原地，用户不用重打。
 */
export async function startCanvasFromComposer(): Promise<boolean> {
  const { prompt, inputImages } = useStore.getState()
  const draft: AgentDraft = {
    prompt,
    references: inputImages.map((image) => ({ id: image.id, dataUrl: image.dataUrl })),
  }
  const submission = draftForSubmit(draft)
  if (!submission.text) return false
  const agent = useAgentStore.getState()
  // 空壳项目会被复用，不会为每一句话堆一个空项目；有内容的就新建。
  if (!(await agent.createProject())) return false
  useStore.getState().setAppMode('canvas')
  if (!agentPanelPresent()) {
    // 没有智能体的部署：画布只有直出生成栏，这句话填进去由用户按下生成；参考图走画布选区，不带。
    if (!(await fillWhenMounted(submission.text))) return false
    useStore.getState().setPrompt('')
    return true
  }
  const result = await useAgentStore.getState().send(submission.text, submission.references, () => {
    const store = useStore.getState()
    store.setPrompt('')
    store.clearInputImages()
  })
  return result !== 'cancelled'
}
