import { useState } from 'react'
import Dialog from '../../../components/patterns/Dialog'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import { useStore } from '../../../store'
import { useVideoStore } from '../../video/store'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import {
  prepareStoryboardFrames,
  prepareStoryboardVideos,
  StoryboardFlowError,
  type StoryboardFrameMode,
  storyboardMissingAssets,
} from '../lib/nodeStoryboardFlow'

export default function StoryboardProductionActions({
  canvas,
  id,
  ready,
  onRun,
}: {
  canvas: NodeCanvasDocument
  id: string
  ready: boolean
  onRun: (ids: string[]) => void
}) {
  const { t } = useTranslation('canvas')
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState<StoryboardFrameMode>('grid')
  const missing = storyboardMissingAssets(canvas, id)
  const apply = (action: () => string[]) => {
    try {
      const ids = action()
      setOpen(false)
      onRun(ids)
    } catch (error) {
      useStore
        .getState()
        .showToast(
          error instanceof StoryboardFlowError ? error.message : t('storyFlow.prepareFailed'),
          'error',
        )
    }
  }
  return (
    <>
      <Button size="sm" variant="outline" disabled={!ready} onClick={() => setOpen(true)}>
        <Icon name="image" />
        {t('storyFlow.frames')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!ready}
        onClick={() =>
          apply(
            () =>
              prepareStoryboardVideos(
                canvas,
                id,
                useVideoStore.getState().draft,
                videoModelOptions(),
              ).videoIds,
          )
        }
      >
        <Icon name="video" />
        {t('storyFlow.videos')}
      </Button>
      {open && (
        <Dialog
          title={t('storyFlow.frames')}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t('storyboard.cancel')}
              </Button>
              <Button
                onClick={() => apply(() => prepareStoryboardFrames(canvas, id, mode).generateIds)}
              >
                {t('storyFlow.review')}
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            {(['grid', 'individual'] as const).map((value) => (
              <Button
                key={value}
                variant={value === mode ? 'secondary' : 'outline'}
                className="h-auto min-h-16 justify-start whitespace-normal py-3 text-left"
                aria-pressed={value === mode}
                onClick={() => setMode(value)}
              >
                <Icon name={value === 'grid' ? 'grid' : 'image'} />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {value === 'grid' ? t('storyFlow.grid') : t('storyFlow.individual')}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {value === 'grid' ? t('storyFlow.gridHint') : t('storyFlow.individualHint')}
                  </span>
                </span>
              </Button>
            ))}
            {missing.length > 0 && (
              <p role="status" className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                {t('storyFlow.noImages', { names: missing.join('、') })}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  )
}
