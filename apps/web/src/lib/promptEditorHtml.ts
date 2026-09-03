import {
  getPromptMentionParts,
  getSelectedImageMentionLabel,
  type MentionLabelResolver,
} from './promptImageMentions'
import { type SlotValues, splitTextIntoSlotParts } from './promptSlots'

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * contentEditable 的胶囊渲染。胶囊 textContent 必须与 `labelFor` 给出的可见文本一致——
 * 光标偏移按它计长，多一个字就整体错位，所以槽位的 ×k 只能走 CSS ::after，不能进 DOM 文本。
 */
export function buildPromptEditorHtml(
  prompt: string,
  labelFor: MentionLabelResolver,
  slotValues: SlotValues,
): string {
  if (!prompt) return ''

  return getPromptMentionParts(prompt, labelFor)
    .map((part) => {
      if (part.type === 'mention') {
        return `<span contenteditable="false" class="mention-tag" data-mention-text="${escapeHtml(getSelectedImageMentionLabel(part.imageIndex))}">${escapeHtml(part.text)}</span>`
      }
      return splitTextIntoSlotParts(part.text)
        .map((slotPart) => {
          if (slotPart.type !== 'slot') return escapeHtml(slotPart.text)
          const count = slotValues[slotPart.name]?.length ?? 0
          const countAttr = count > 1 ? ` data-slot-count="×${count}"` : ''
          return `<span contenteditable="false" class="mention-tag slot-tag" data-slot-name="${escapeHtml(slotPart.name)}" data-mention-text="${escapeHtml(slotPart.text)}"${countAttr}>${escapeHtml(slotPart.text)}</span>`
        })
        .join('')
    })
    .join('')
}
