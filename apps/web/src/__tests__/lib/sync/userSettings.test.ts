import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setChannels } from '../../../lib/channels/channelStore'
import { applyUserSettingsDocument, readUserSettingsDocument } from '../../../lib/sync/userSettings'
import { useStore } from '../../../store'
import { DEFAULT_PARAMS } from '../../../types'

const CHANNEL = {
  id: 'openai-main',
  label: 'OpenAI',
  kind: 'openai-queue' as const,
  models: [
    { id: 'gpt-image-1', label: 'gpt-image-1', capabilities: ['edit' as const] },
    { id: 'gpt-image-2', label: 'gpt-image-2', capabilities: ['edit' as const] },
  ],
  defaults: {},
}

beforeEach(() => {
  setChannels([CHANNEL])
  useStore.setState({
    settings: {
      clearInputAfterSubmit: false,
      persistInputOnRestart: true,
      alwaysShowRetryButton: false,
      enterSubmit: false,
      profiles: [
        {
          id: 'openai-main',
          source: 'builtin-edge',
          channelId: 'openai-main',
          selectedModelId: 'gpt-image-1',
        },
      ],
      activeProfileId: 'openai-main',
    },
    params: { ...DEFAULT_PARAMS },
    appMode: 'image',
    pinnedInspirationIds: [],
    inspirationCoachDismissed: false,
    libraryCoachDismissed: false,
    libraryPanelOpened: false,
    assetHintShown: false,
    prompt: '还在打的草稿',
    slotValues: { 背景: ['浴室'] },
    tasks: [],
  })
})

afterEach(() => {
  setChannels([])
})

describe('the user settings document', () => {
  it('carries behaviour switches, params, pins and coach marks without navigation', () => {
    useStore.getState().setSettings({ enterSubmit: true, alwaysShowRetryButton: true })
    useStore.getState().setParams({ n: 3 })
    useStore.getState().setAppMode('image')
    useStore.getState().toggleInspirationPin('inspiration-7')
    useStore.getState().dismissLibraryCoach()

    const document = readUserSettingsDocument()

    expect(document.enterSubmit).toBe(true)
    expect(document.alwaysShowRetryButton).toBe(true)
    expect(document.params.n).toBe(3)
    expect(document).not.toHaveProperty('appMode')
    expect(document.pinnedInspirationIds).toEqual(['inspiration-7'])
    expect(document.libraryCoachDismissed).toBe(true)
  })

  it('leaves drafts and device-local state out', () => {
    const document = readUserSettingsDocument()

    expect(Object.keys(document).sort()).toEqual([
      'alwaysShowRetryButton',
      'assetHintShown',
      'builtinChannel',
      'clearInputAfterSubmit',
      'enterSubmit',
      'inspirationCoachDismissed',
      'libraryCoachDismissed',
      'libraryPanelOpened',
      'params',
      'persistInputOnRestart',
      'pinnedInspirationIds',
    ])
    expect(JSON.stringify(document)).not.toContain('sk-secret-value')
  })

  it('carries the selected platform channel and model', () => {
    useStore.getState().setSettings({ activeProfileId: 'openai-main' })

    expect(readUserSettingsDocument().builtinChannel).toEqual({
      channelId: 'openai-main',
      modelId: 'gpt-image-1',
    })
  })

  it('a leftover BYOK profile id falls back to the platform channel', () => {
    useStore.getState().setSettings({ activeProfileId: 'byok-1' })

    expect(readUserSettingsDocument().builtinChannel).toEqual({
      channelId: 'openai-main',
      modelId: 'gpt-image-1',
    })
  })
})

describe('applying a document from another device', () => {
  it('applies settings without restoring another device’s page', () => {
    applyUserSettingsDocument({
      ...readUserSettingsDocument(),
      enterSubmit: true,
      params: { ...DEFAULT_PARAMS, n: 4 },
      appMode: 'canvas',
      pinnedInspirationIds: ['from-other-device'],
      inspirationCoachDismissed: true,
    })

    const state = useStore.getState()
    expect(state.settings.enterSubmit).toBe(true)
    expect(state.params.n).toBe(4)
    expect(state.appMode).toBe('image')
    expect(state.pinnedInspirationIds).toEqual(['from-other-device'])
    expect(state.inspirationCoachDismissed).toBe(true)
  })

  it('keeps the local draft and stays on the platform channel', () => {
    applyUserSettingsDocument({ ...readUserSettingsDocument(), enterSubmit: true })

    const state = useStore.getState()
    expect(state.settings.profiles.map((profile) => profile.id)).toEqual(['openai-main'])
    expect(state.settings.profiles.every((profile) => profile.source === 'builtin-edge')).toBe(true)
    expect(state.prompt).toBe('还在打的草稿')
    expect(state.slotValues).toEqual({ 背景: ['浴室'] })
  })

  it('selects the platform channel and model named by the document', () => {
    applyUserSettingsDocument({
      ...readUserSettingsDocument(),
      builtinChannel: { channelId: 'openai-main', modelId: 'gpt-image-2' },
    })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe('openai-main')
    expect(state.settings.profiles.find((profile) => profile.id === 'openai-main')).toMatchObject({
      selectedModelId: 'gpt-image-2',
    })
  })

  it('keeps the local choice when this deployment has no such channel', () => {
    applyUserSettingsDocument({
      ...readUserSettingsDocument(),
      builtinChannel: { channelId: 'somewhere-else', modelId: 'unknown' },
    })

    expect(useStore.getState().settings.activeProfileId).toBe('openai-main')
  })

  it('does not interrupt navigation already chosen in this session', () => {
    useStore.getState().setAppMode('image')
    applyUserSettingsDocument({ ...readUserSettingsDocument(), appMode: 'canvas' })

    expect(useStore.getState().appMode).toBe('image')
  })

  it('ignores a document that is not an object', () => {
    applyUserSettingsDocument(null)
    applyUserSettingsDocument('nonsense')

    expect(useStore.getState().settings.enterSubmit).toBe(false)
  })
})
