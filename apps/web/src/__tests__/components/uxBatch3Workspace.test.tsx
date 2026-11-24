// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { VideoModelSupport } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ScriptBriefDialog from '../../features/canvas/components/ScriptBriefDialog'
import { NumberField } from '../../features/toolbox/components/fields'
import VideoPresetRows from '../../features/video/components/VideoPresetRows'
import { INITIAL_VIDEO_DRAFT } from '../../features/video/store'
import { useCloseOnEscape } from '../../hooks/useCloseOnEscape'
import { useStore } from '../../store'
import { stubPointerApis } from '../helpers/radix'

const crossLockSupport: VideoModelSupport = {
  label: 'Cross Lock Video',
  durations: [5, 8],
  aspectRatios: ['16:9'],
  resolutions: ['720p', '1080p'],
  resolutionMultipliers: { '720p': 1, '1080p': 1.6 },
  durationsByResolution: {
    '720p': [5, 8],
    '1080p': [8],
  },
  firstFrame: true,
  lastFrame: false,
  extend: false,
  edit: false,
  typicalSeconds: 40,
  tagline: 'Test',
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  stubPointerApis()
  useStore.setState({ confirmDialog: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('Toolbox NumberField', () => {
  it('allows clearing digits while typing and restores valid value on blur', async () => {
    const onChange = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(<NumberField value={200} onChange={onChange} unit="KB" label="目标体积" />),
      )
      const input = host.querySelector<HTMLInputElement>('input[type="number"]')!
      expect(input.value).toBe('200')

      await act(async () => setNativeValue(input, ''))
      expect(input.value).toBe('')
      expect(onChange).not.toHaveBeenCalled()

      await act(async () => setNativeValue(input, '50'))
      expect(onChange).toHaveBeenCalledWith(50)

      await act(async () => setNativeValue(input, ''))
      await act(async () => {
        input.focus()
        input.blur()
      })
      expect(input.value).toBe('200')
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('VideoPresetRows auto-adjustment', () => {
  it('keeps paired resolution and duration selectable and auto-adjusts the other field', async () => {
    const onChange = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <VideoPresetRows
            support={crossLockSupport}
            draft={{ ...INITIAL_VIDEO_DRAFT, duration: 5, resolution: '720p' }}
            aspectFollowsFirstFrame={false}
            onChange={onChange}
          />,
        ),
      )
      const btn1080 = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.textContent?.includes('1080p'),
      )!
      expect(btn1080.disabled).toBe(false)
      await act(async () => btn1080.click())
      expect(onChange).toHaveBeenCalledWith({ resolution: '1080p', duration: 8 })

      onChange.mockClear()
      await act(async () =>
        root.render(
          <VideoPresetRows
            support={crossLockSupport}
            draft={{ ...INITIAL_VIDEO_DRAFT, duration: 8, resolution: '1080p' }}
            aspectFollowsFirstFrame={false}
            onChange={onChange}
          />,
        ),
      )
      const btn5s = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.textContent?.includes('5'),
      )!
      expect(btn5s.disabled).toBe(false)
      await act(async () => btn5s.click())
      expect(onChange).toHaveBeenCalledWith({ duration: 5, resolution: '720p' })
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('useCloseOnEscape IME guard', () => {
  it('ignores Escape during IME composition and closes on normal Escape', async () => {
    const onClose = vi.fn()
    function Fixture() {
      useCloseOnEscape(true, onClose)
      return null
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<Fixture />))
      await act(async () => {
        const imeEsc = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
        Object.defineProperty(imeEsc, 'isComposing', { value: true })
        window.dispatchEvent(imeEsc)
      })
      expect(onClose).not.toHaveBeenCalled()

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('ScriptBriefDialog dirty template switch guard', () => {
  it('prompts confirmation before overwriting user edits when switching templates', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(<ScriptBriefDialog onClose={() => {}} onConfirm={() => {}} />),
      )
      const titleInput = document.querySelector<HTMLInputElement>('input')!
      await act(async () => setNativeValue(titleInput, '我的自定义剧本'))

      const templateBtns = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
      )
      expect(templateBtns.length).toBeGreaterThan(1)
      await act(async () => templateBtns[1]!.click())

      expect(useStore.getState().confirmDialog).not.toBeNull()
      expect(titleInput.value).toBe('我的自定义剧本')
    } finally {
      await act(async () => root.unmount())
    }
  })
})
