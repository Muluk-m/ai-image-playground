# assistant-ui Elements

The components added here are adapted from [assistant-ui](https://github.com/assistant-ui/assistant-ui/tree/4fffd182971380758dcda062ea076f7bc9257fee/packages/ui/src/components/react/assistant-ui/elements), pinned at `4fffd182971380758dcda062ea076f7bc9257fee` (MIT; see LICENSE).

Source files: `option-list.tsx`, `approval-card.tsx`, `tool-call.tsx`, `tool-error.tsx`, `message-actions.tsx`, `thinking-indicator.tsx`, `suggestions.tsx`, `surfaces.tsx`.

Local adaptations:
- Existing shadcn Button and Muvloom theme tokens; Tailwind 3 classes and existing reduced-motion shimmer.
- OptionList supports our single-answer contract only. Persisted conversation history controls its receipt, so refused/unauthenticated sends never become falsely confirmed.
- ApprovalCard has an editable content slot and disabled confirmation; caller owns translations and submission state.
- ToolCall uses our shadcn Button with aria-expanded/aria-controls for disclosure, without a new runtime/dependency. Details stay mounted while collapsed. The header leads with a slowly spinning star instead of the chevron and drops the success check; the chevron only appears on hover, focus or when open.
- ThinkingIndicator uses the same spinning star as ToolCall instead of the pulsing dot.
- ToolError accepts existing recovery actions and truthful human-readable errors; no invented attempt counts or unsupported Skip button.
- MessageActions renders only supported actions. More uses the existing Radix Popover at the caller; all labels come from i18n.
- Suggestions retain fill-and-focus behavior without submitting. Existing image-generation intentionally retains our compact gradient placeholder instead of upstream dots/blur.

No assistant-ui runtime migration: existing Agent store, transport, persistence and billing remain authoritative.
