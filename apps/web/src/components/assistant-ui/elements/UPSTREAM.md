# assistant-ui Elements

The components added here are adapted from [assistant-ui](https://github.com/assistant-ui/assistant-ui/tree/4fffd182971380758dcda062ea076f7bc9257fee/packages/ui/src/components/react/assistant-ui/elements), pinned at `4fffd182971380758dcda062ea076f7bc9257fee` (MIT; see LICENSE).

Source files: `option-list.tsx`, `approval-card.tsx`, `tool-call.tsx`, `tool-error.tsx`, `message-actions.tsx`, `thinking-indicator.tsx`, `suggestions.tsx`, `surfaces.tsx`.

Local adaptations:
- Existing shadcn Button and Muvloom theme tokens; Tailwind 3 classes and existing reduced-motion shimmer.
- OptionList supports our single-answer contract only. Persisted conversation history controls its receipt, so refused/unauthenticated sends never become falsely confirmed.
- ApprovalCard has an editable content slot and disabled confirmation; caller owns translations and submission state.
- ToolCall is a plain borderless row (spark + label) aligned with the thinking indicator; details sit under a thin left rule and stay mounted while collapsed. A spinning/breathing spark marks running, a faded one done; the chevron only appears on hover, focus or when open.
- ThinkingIndicator uses the same spark as ToolCall instead of the pulsing dot.
- ToolError accepts existing recovery actions and truthful human-readable errors; no invented attempt counts or unsupported Skip button.
- MessageActions renders only supported actions. More uses the existing Radix Popover at the caller; all labels come from i18n.
- Suggestions retain fill-and-focus behavior without submitting. ImageGeneration uses the upstream dot field without a fake completed-image gradient; real artifacts take over when ready.

No assistant-ui runtime migration: existing Agent store, transport, persistence and billing remain authoritative.

## Composer and run-state updates (2026-10-09)

`reasoning-effort.tsx`, `stopped-run.tsx`, and `image-generation.tsx` are adapted from the official `https://r.assistant-ui.com/elements-<name>.json` registry fetched on 2026-10-09.
`attachment.tsx` and `composer-trigger-popover.tsx` adapt the presentation in `attachment.aui.radix.tsx` and `composer-trigger-popover.aui.tsx` at assistant-ui commit `9121416f70e5fed68eaf7f8922a726e289e98aa5`.

- Attachment tiles are compact and use a stable image skeleton while the confirmed cloud preview loads. Upload/retry/remove/mask actions retain the existing media ownership and send gating.
- Trigger popovers use shadcn Button rows; the existing marked contenteditable editor owns `/` / `@` matching, IME, arrow/Enter/Tab/Escape, and serialized skill chips. This is a props-driven presentation adaptation, not `unstable_useSlashCommandAdapter` or a runtime migration.
- ReasoningEffort maps to the existing fast/medium/deep values. Providers do not report a token budget, so no invented progress/budget meter is displayed.
- StoppedRun shows existing cancellation receipts and only supported recovery actions. It does not pretend a cancelled paid generation can resume, or offer to discard persisted history.
- OptionList retains persisted answer receipts and free-text answers. ThinkingIndicator remains the shared sending/thinking/stopping/job-status component.

## Generation presentation (2026-10-09)

`job-progress.tsx` and `image-gallery.tsx` adapt the official Elements registry fetched on 2026-10-09.

- JobProgress uses a continuous monochrome track. Generation jobs expose phases and elapsed time only, so their track is indeterminate; batch inbox percentages count completed and failed items.
- ImageGallery retains artifact ids while browsing one full-width image, with arrow buttons, keyboard navigation and thumbnails. Existing preview, download and canvas actions own media access.
- Image/video waiting surfaces and recovery controls use neutral theme tokens and icon buttons with translated accessible labels. Portrait playback keeps a height cap within the full-width result card.
