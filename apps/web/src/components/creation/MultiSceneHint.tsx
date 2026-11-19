import { useState } from 'react'
import { useTranslation } from '../../i18n'
import { shouldShowMultiSceneHint } from '../../lib/multiSceneHint'
import { useStore } from '../../store'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import type { CreationMode } from './draft'

const AGENT_MARK = '__AGENT__'

export function MultiSceneHint({
  prompt,
  imageCount,
  creationMode,
}: {
  prompt: string
  imageCount: number
  creationMode: CreationMode
}) {
  const { t } = useTranslation('composer')
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null)
  const count = shouldShowMultiSceneHint({ prompt, imageCount, creationMode, dismissedPrompt })
  if (count === null) return null

  const agentLabel = t('multiScene.handToAgent')
  const [before, after] = t('multiScene.hint', { count, agent: AGENT_MARK }).split(AGENT_MARK)

  return (
    <div className="creation-multi-scene-hint" role="status" data-testid="multi-scene-hint">
      <p className="creation-multi-scene-hint-text">
        {before}
        <Button
          type="button"
          variant="link"
          className="creation-multi-scene-hint-agent h-auto p-0 text-xs font-normal text-inherit underline"
          onClick={() => useStore.getState().setCreateTarget('chat')}
        >
          {agentLabel}
        </Button>
        {after}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="creation-multi-scene-hint-dismiss"
        aria-label={t('multiScene.dismiss')}
        onClick={() => setDismissedPrompt(prompt)}
      >
        <Icon name="close" />
      </Button>
    </div>
  )
}
