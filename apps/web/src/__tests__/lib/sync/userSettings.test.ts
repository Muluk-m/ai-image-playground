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
      customProviders: [],
      clearInputAfterSubmit: false,
      persistInputOnRestart: true,
      reuseTaskApiProfileTemporarily: false,
      alwaysShowRetryButton: false,
      enterSubmit: false,
      profiles: [
        {
          id: 'byok-1',
          source: 'user-byok',
          name: '我的网关',
          kind: 'openai-compat',
          baseUrl: 'https://gateway.example.com',
          apiKey: 'sk-secret-value',
          models: ['gpt-image-1'],
          selectedModelId: 'gpt-image-1',
          preferences: { apiMode: 'images', timeout: 300, codexCli: false, apiProxy: false },
        },
      ],
      activeProfileId: 'byok-1',
    },
    params: { ...DEFAULT_PARAMS },
    appMode: 'browse',
    pinnedInspirationIds: [],
    inspirationCoachDismissed: false,
    libraryCoachDismissed: false,
    libraryPanelOpened: false,
    assetHintShown: false,
    prompt: '还在打的草稿',
    slotValues: { 背景: ['浴室'] },
    tasks: [],
    profileModelCache: { 'byok-1': ['gpt-image-1'] },
  })
})

afterEach(() => {
  setChannels([])
})

describe('the user settings document', () => {
  it('carries the behaviour switches, params, mode, pins and coach marks', () => {
    useStore.getState().setSettings({ enterSubmit: true, alwaysShowRetryButton: true })
    useStore.getState().setParams({ n: 3 })
    useStore.getState().setAppMode('product')
    useStore.getState().toggleInspirationPin('inspiration-7')
    useStore.getState().dismissLibraryCoach()

    const document = readUserSettingsDocument()

    expect(document.enterSubmit).toBe(true)
    expect(document.alwaysShowRetryButton).toBe(true)
    expect(document.params.n).toBe(3)
    expect(document.appMode).toBe('product')
    expect(document.pinnedInspirationIds).toEqual(['inspiration-7'])
    expect(document.libraryCoachDismissed).toBe(true)
  })

  it('leaves keys, drafts and device-local state out', () => {
    const document = readUserSettingsDocument()

    expect(Object.keys(document).sort()).toEqual([
      'alwaysShowRetryButton',
      'appMode',
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
      'reuseTaskApiProfileTemporarily',
    ])
    expect(JSON.stringify(document)).not.toContain('sk-secret-value')
  })

  it('carries the selected builtin channel and model, never a BYOK profile', () => {
    useStore.getState().setSettings({ activeProfileId: 'openai-main' })

    expect(readUserSettingsDocument().builtinChannel).toEqual({
      channelId: 'openai-main',
      modelId: 'gpt-image-1',
    })

    useStore.getState().setSettings({ activeProfileId: 'byok-1' })
    expect(readUserSettingsDocument().builtinChannel).toBeNull()
  })
})

describe('applying a document from another device', () => {
  it('writes the switches, params, mode, pins and coach marks', () => {
    applyUserSettingsDocument({
      ...readUserSettingsDocument(),
      enterSubmit: true,
      params: { ...DEFAULT_PARAMS, n: 4 },
      appMode: 'create',
      pinnedInspirationIds: ['from-other-device'],
      inspirationCoachDismissed: true,
    })

    const state = useStore.getState()
    expect(state.settings.enterSubmit).toBe(true)
    expect(state.params.n).toBe(4)
    expect(state.appMode).toBe('create')
    expect(state.pinnedInspirationIds).toEqual(['from-other-device'])
    expect(state.inspirationCoachDismissed).toBe(true)
  })

  it('keeps this device BYOK profiles and drafts untouched', () => {
    applyUserSettingsDocument({ ...readUserSettingsDocument(), enterSubmit: true })

    const state = useStore.getState()
    expect(state.settings.profiles.some((profile) => profile.id === 'byok-1')).toBe(true)
    expect(state.prompt).toBe('还在打的草稿')
    expect(state.slotValues).toEqual({ 背景: ['浴室'] })
  })

  it('selects the builtin channel and model named by the document', () => {
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

    expect(useStore.getState().settings.activeProfileId).toBe('byok-1')
  })

  it('ignores a mode this deployment does not offer', () => {
    applyUserSettingsDocument({ ...readUserSettingsDocument(), appMode: 'video' })

    expect(useStore.getState().appMode).toBe('browse')
  })

  it('ignores a document that is not an object', () => {
    applyUserSettingsDocument(null)
    applyUserSettingsDocument('nonsense')

    expect(useStore.getState().settings.enterSubmit).toBe(false)
  })
})
