import type { AgentMarkedRegion } from '@image-playground/shared'
import { accountRequired } from '../../../auth/loginPrompt'
import { i18next } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { loadImage } from '../../../lib/canvasImage'
import { modelSupportsNativeMask } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
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
import { maskedEditSizeRefusal } from './maskedEditLimits'

/** 画布快捷操作只组织 Agent 的一轮输入；生成、排队和落图仍由 Agent 对话负责。 */
export async function sendImageEditToAgent(
  editor: CanvasEditor,
  image: ImageEl,
  instruction: string,
  options: {
    strokes?: readonly MaskStroke[]
    regions?: readonly AgentMarkedRegion[]
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
  const profile = getActiveApiProfile(useStore.getState().settings)
  const model = clientProfileToApiProfile(profile).model
  const masked = Boolean(options.strokes?.length || options.frame?.mode === 'outpaint')
  if (masked && !modelSupportsNativeMask(profile, getPublicChannels())) {
    useStore.getState().showToast(i18next.t('inpaint.modelUnsupported', { ns: 'canvas' }), 'error')
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
      const refusal = maskedEditSizeRefusal(target.width, target.height)
      if (refusal) {
        useStore.getState().showToast(refusal, 'error')
        return false
      }
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
        const outputSize = rectPixelSize(options.frame.rect, current, workingNatural)
        const sizeRefusal = maskedEditSizeRefusal(outputSize.width, outputSize.height)
        if (sizeRefusal) {
          useStore.getState().showToast(sizeRefusal, 'error')
          return false
        }
        const input = await buildOutpaintInputs(
          original,
          options.frame.rect,
          current,
          workingNatural,
        )
        const refusal = maskedEditSizeRefusal(input.width, input.height)
        if (refusal) {
          useStore.getState().showToast(refusal, 'error')
          return false
        }
        dataUrl = input.source
        maskDataUrl = input.mask
      }
    }
    const references = [
      {
        imageId: image.id,
        dataUrl,
        ...(maskDataUrl ? { maskDataUrl } : {}),
        ...(options.regions?.length ? { regions: options.regions } : {}),
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
        .send(
          instruction.trim(),
          references,
          () => finish(true),
          'image',
          undefined,
          undefined,
          model,
        )
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
