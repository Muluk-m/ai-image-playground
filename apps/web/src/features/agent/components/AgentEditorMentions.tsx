import type { AgentSkillSummary } from '@image-playground/shared'
import { type ReactNode, type RefObject, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import MediaImage from '../../../components/MediaImage'
import {
  getContentEditableSelection,
  setContentEditableSelection,
  syncMentionTagSelection,
} from '../../../lib/promptEditorDom'
import { buildPromptEditorHtml } from '../../../lib/promptEditorHtml'
import {
  getMentionedImageIndexes,
  type MentionLabelResolver,
} from '../../../lib/promptImageMentions'
import { getLeadingAgentSkill } from '../lib/agentSkillMentions'
import type { AgentReference } from '../lib/references'
import AgentSkillBadge from './AgentSkillBadge'

interface MentionTarget {
  element: HTMLElement
  content: ReactNode
  key: string
}

/** React owns the previews; the editor owns atomic nodes and canonical prompt serialization. */
export default function AgentEditorMentions({
  editorRef,
  typedRef,
  composingRef,
  prompt,
  labels,
  references,
  skills,
}: {
  editorRef: RefObject<HTMLDivElement | null>
  typedRef: RefObject<string | null>
  composingRef: RefObject<boolean>
  prompt: string
  labels: MentionLabelResolver
  references: readonly AgentReference[]
  skills: readonly AgentSkillSummary[]
}) {
  const [targets, setTargets] = useState<readonly MentionTarget[]>([])
  useLayoutEffect(() => {
    const editor = editorRef.current
    const typed = typedRef.current
    typedRef.current = null
    if (!editor) return
    const invocation = getLeadingAgentSkill(prompt, skills)
    const promoteTypedSkill =
      invocation?.rest && !composingRef.current && !editor.querySelector('[data-skill-command]')
    if (prompt === typed && !promoteTypedSkill) {
      setTargets((current) =>
        current.every(({ element }) => editor.contains(element))
          ? current
          : current.filter(({ element }) => editor.contains(element)),
      )
      return
    }

    const selection = document.activeElement === editor ? getContentEditableSelection(editor) : null
    editor.innerHTML = buildPromptEditorHtml(prompt, labels, {})
    const next: MentionTarget[] = []
    for (const element of editor.querySelectorAll<HTMLElement>('.mention-tag:not(.slot-tag)')) {
      const index = getMentionedImageIndexes(element.dataset.mentionText ?? '')[0]
      const reference = index === undefined ? undefined : references[index]
      if (!reference) continue
      const label = element.textContent ?? ''
      element.dataset.mentionLabel = label
      element.classList.add('agent-image-mention')
      element.setAttribute('aria-label', label)
      element.title = label
      element.textContent = ''
      next.push({
        element,
        key: `image-${next.length}`,
        content: (
          <>
            <MediaImage
              src={reference.dataUrl}
              alt=""
              draggable={false}
              className="h-6 w-6 shrink-0 rounded object-cover"
            />
            {reference.name && <span className="max-w-36 truncate">{reference.name}</span>}
          </>
        ),
      })
    }
    const first = editor.firstChild
    if (invocation && first instanceof Text && first.data.startsWith(invocation.command)) {
      first.splitText(invocation.command.length)
      const element = document.createElement('span')
      element.contentEditable = 'false'
      element.className = 'mention-tag agent-skill-mention'
      element.dataset.mentionText = invocation.command
      element.dataset.mentionLabel = invocation.command
      element.dataset.skillCommand = invocation.skill.name
      element.setAttribute('aria-label', invocation.skill.title)
      first.replaceWith(element)
      next.push({ element, key: 'skill', content: <AgentSkillBadge skill={invocation.skill} /> })
    }
    setTargets(next)
    if (selection) {
      setContentEditableSelection(editor, selection)
      syncMentionTagSelection(editor)
    }
  }, [editorRef, typedRef, composingRef, prompt, labels, references, skills])

  return targets.map(({ element, content, key }) => createPortal(content, element, key))
}
