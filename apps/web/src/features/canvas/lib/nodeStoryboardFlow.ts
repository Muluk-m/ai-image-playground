import {
  prepareStoryboardFrames as prepareFrames,
  prepareStoryboardVideos as prepareVideos,
  type StoryboardFlowContext,
  StoryboardFlowError,
  type StoryboardFlowErrorCode,
  type StoryboardFrameMode,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import type { VideoModelOption } from '../../../lib/channels/videoChannels'
import type { VideoDraft } from '../../video/types'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

const t = i18next.getFixedT(null, 'canvas')

function context(canvas: NodeCanvasDocument): StoryboardFlowContext {
  return {
    origin: canvas.origin,
    names: {
      frame: (index) => t('storyFlow.frameName', { index }),
      grid: (index) => t('storyFlow.gridName', { index }),
      video: (index) => t('storyFlow.videoName', { index }),
    },
  }
}

/** Document preparation is one undo step; only the batch confirmation starts generation. */
function prepare<T>(canvas: NodeCanvasDocument, action: () => T): T {
  canvas.undo.stopCapturing()
  try {
    return action()
  } catch (error) {
    if (error instanceof StoryboardFlowError) {
      const messages: Record<StoryboardFlowErrorCode, string> = {
        finalizeFirst: t('storyFlow.finalizeFirst'),
        noFirstFrameModel: t('storyFlow.noFirstFrameModel'),
        framesMissing: t('storyFlow.framesMissing'),
        promptTooLong: t('storyFlow.promptTooLong'),
        missingAssets: t('storyFlow.noImages', { names: error.assets.join('、') }),
      }
      error.message = messages[error.code]
    }
    throw error
  } finally {
    canvas.undo.stopCapturing()
  }
}

export function prepareStoryboardFrames(
  canvas: NodeCanvasDocument,
  id: string,
  mode: StoryboardFrameMode,
) {
  return prepare(canvas, () => prepareFrames(canvas.doc, id, mode, context(canvas)))
}

export function prepareStoryboardVideos(
  canvas: NodeCanvasDocument,
  id: string,
  draft: VideoDraft,
  options: readonly VideoModelOption[],
) {
  const model =
    options.find((option) => option.modelId === draft.model && option.support.firstFrame) ??
    options.find((option) => option.support.firstFrame)
  return prepare(canvas, () => prepareVideos(canvas.doc, id, draft, model, context(canvas)))
}
