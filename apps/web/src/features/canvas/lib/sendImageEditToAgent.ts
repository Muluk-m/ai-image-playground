import { accountRequired } from '../../../auth/loginPrompt'
import { i18next } from '../../../i18n'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { prepareMaskTargetDataUrl } from '../../../lib/maskPreprocess'
import { useStore } from '../../../store'
import { agentPanelPresent } from '../../agent/panelLayout'
import { useAgentStore } from '../../agent/store'
import type { ImageEl } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { exportMaskDataUrl, type MaskStroke } from './inpaintMask'

/** 画布快捷操作只组织 Agent 的一轮输入；生成、排队和落图仍由 Agent 对话负责。 */
export async function sendImageEditToAgent(
  editor: CanvasEditor,
  image: ImageEl,
  instruction: string,
  options: { strokes?: readonly MaskStroke[]; referenceDataUrl?: string } = {},
): Promise<boolean> {
  const current = editor.getElement(image.id)
  const source = current?.type === 'image' ? editor.doc.files[current.fileId] : undefined
  if (!source || current?.type !== 'image') {
    useStore
      .getState()
      .showToast(i18next.t('imageToolbar.sourceMissing', { ns: 'canvas' }), 'error')
    return false
  }
  const agent = useAgentStore.getState()
  if (!agentPanelPresent() || agent.historyLoading || agent.historyFailed) {
    useStore
      .getState()
      .showToast(i18next.t('imageToolbar.agentUnavailable', { ns: 'canvas' }), 'error')
    return false
  }
  try {
    let dataUrl = source
    let maskDataUrl: string | undefined
    if (options.strokes?.length) {
      const original = await resolveMediaSource(source, 'original')
      const target = await prepareMaskTargetDataUrl(original)
      dataUrl = target.dataUrl
      maskDataUrl = await exportMaskDataUrl(
        current,
        { width: target.width, height: target.height },
        options.strokes,
      )
    }
    const references = [
      {
        imageId: image.id,
        dataUrl,
        ...(maskDataUrl ? { maskDataUrl } : {}),
      },
      ...(options.referenceDataUrl
        ? [{ imageId: crypto.randomUUID(), dataUrl: options.referenceDataUrl }]
        : []),
    ]
    agent.setOpen(true)
    agent.setTab('chat')
    let accepted = false
    const result = await useAgentStore.getState().send(
      instruction.trim(),
      references,
      () => {
        accepted = true
      },
      'image',
    )
    if (accepted) return true
    if (
      result !== 'cancelled' &&
      !(isClientCapabilityEnabled('billing:credits') && accountRequired())
    )
      useStore
        .getState()
        .showToast(i18next.t('imageToolbar.agentUnavailable', { ns: 'canvas' }), 'error')
    return false
  } catch (error) {
    useStore.getState().showToast(error instanceof Error ? error.message : String(error), 'error')
    return false
  }
}
