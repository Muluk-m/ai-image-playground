import { accountRequired } from '../../../auth/loginPrompt'
import { i18next } from '../../../i18n'
import { loadImage } from '../../../lib/canvasImage'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { calculateMaskWorkingSize, prepareMaskTargetDataUrl } from '../../../lib/maskPreprocess'
import { useStore } from '../../../store'
import { agentPanelPresent } from '../../agent/panelLayout'
import { useAgentStore } from '../../agent/store'
import type { EditRect } from '../rectEditStore'
import type { ImageEl } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { buildOutpaintInputs, cropBitmap, rectPixelSize } from './imageRectEdit'
import { exportMaskDataUrl, type MaskStroke } from './inpaintMask'

/** 画布快捷操作只组织 Agent 的一轮输入；生成、排队和落图仍由 Agent 对话负责。 */
export async function sendImageEditToAgent(
  editor: CanvasEditor,
  image: ImageEl,
  instruction: string,
  options: {
    strokes?: readonly MaskStroke[]
    referenceDataUrl?: string
    frame?: { mode: 'crop' | 'outpaint'; rect: EditRect }
  } = {},
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
    } else if (options.frame) {
      const original = await resolveMediaSource(source, 'original')
      const loaded = await loadImage(original)
      const natural = { width: loaded.naturalWidth, height: loaded.naturalHeight }
      if (options.frame.mode === 'crop') {
        dataUrl = await cropBitmap(original, options.frame.rect, current, natural)
      } else {
        const desired = rectPixelSize(options.frame.rect, current, natural)
        const fitted = calculateMaskWorkingSize(desired.width, desired.height)
        const scale = Math.min(1, fitted.width / desired.width, fitted.height / desired.height)
        const workingNatural = {
          width: Math.max(1, Math.round(natural.width * scale)),
          height: Math.max(1, Math.round(natural.height * scale)),
        }
        const input = await buildOutpaintInputs(
          original,
          options.frame.rect,
          current,
          workingNatural,
        )
        dataUrl = input.source
        maskDataUrl = input.mask
      }
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
    // AgentStore.send 会跟随整轮生成；快捷菜单只等服务端受理就收起，后续进度留在对话里。
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (accepted: boolean) => {
        if (settled) return
        settled = true
        resolve(accepted)
      }
      void useAgentStore
        .getState()
        .send(instruction.trim(), references, () => finish(true), 'image')
        .then(
          (result) => {
            if (
              !settled &&
              result !== 'cancelled' &&
              !(isClientCapabilityEnabled('billing:credits') && accountRequired())
            )
              useStore
                .getState()
                .showToast(i18next.t('imageToolbar.agentUnavailable', { ns: 'canvas' }), 'error')
            finish(false)
          },
          (error: unknown) => {
            if (!settled)
              useStore
                .getState()
                .showToast(error instanceof Error ? error.message : String(error), 'error')
            finish(false)
          },
        )
    })
  } catch (error) {
    useStore.getState().showToast(error instanceof Error ? error.message : String(error), 'error')
    return false
  }
}
