// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildPromptEditorHtml } from '../../lib/promptEditorHtml'
import { createMentionLabels, getSelectedImageMentionLabel } from '../../lib/promptImageMentions'
import type { InputImage } from '../../types'

const images: InputImage[] = [{ id: 'image-a', dataUrl: 'data:image/png;base64,a' }]
const labels = createMentionLabels(images)

function render(prompt: string, slotValues: Record<string, string[]> = {}, labelFor = labels) {
  const el = document.createElement('div')
  el.innerHTML = buildPromptEditorHtml(prompt, labelFor, slotValues)
  return el
}

describe('prompt editor html', () => {
  it('renders a typed slot as a chip whose text stays the raw slot syntax', () => {
    const el = render('把背景换成{背景}', { 背景: ['浴室', '厨房'] })
    const chip = el.querySelector<HTMLElement>('.slot-tag')

    expect(chip?.textContent).toBe('{背景}')
    expect(chip?.dataset.slotName).toBe('背景')
    expect(el.textContent).toBe('把背景换成{背景}')
  })

  it('shows the value count only when a slot holds more than one value', () => {
    expect(
      render('{背景}', { 背景: ['浴室', '厨房'] }).querySelector<HTMLElement>('.slot-tag')?.dataset
        .slotCount,
    ).toBe('×2')
    expect(
      render('{背景}', { 背景: ['浴室'] }).querySelector<HTMLElement>('.slot-tag')?.dataset
        .slotCount,
    ).toBeUndefined()
    expect(
      render('{背景}').querySelector<HTMLElement>('.slot-tag')?.dataset.slotCount,
    ).toBeUndefined()
  })

  it('renders image mentions and slots side by side', () => {
    const el = render(`${getSelectedImageMentionLabel(0)} 放进{场景}`, { 场景: ['浴室'] })

    expect(el.querySelectorAll('.mention-tag')).toHaveLength(2)
    expect(el.querySelector('.mention-tag:not(.slot-tag)')?.textContent).toBe('@图1')
    expect(el.querySelector('.slot-tag')?.textContent).toBe('{场景}')
  })

  it('renders a mention with the name its image carries', () => {
    const el = render(
      `${getSelectedImageMentionLabel(0)} 放大`,
      {},
      createMentionLabels(images, { 'image-a': '熊猫' }),
    )
    const chip = el.querySelector<HTMLElement>('.mention-tag:not(.slot-tag)')

    expect(chip?.textContent).toBe('@熊猫')
    expect(chip?.dataset.mentionText).toBe(getSelectedImageMentionLabel(0))
  })

  it('escapes markup in prompt text and slot names', () => {
    const el = render('<b>粗</b>{<i>}', { '<i>': ['x'] })

    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('i')).toBeNull()
    expect(el.textContent).toBe('<b>粗</b>{<i>}')
  })
})
