# Project navigation — selected A

The user selected prototype A on 2026-09-17. Prototype source is preserved on
`codex/prototype-project-navigation` at `314af458`, in
`docs/design/prototypes/project-navigation/`.

## Accepted behavior

- Put the current project above the chat/creation-record tabs.
- The title opens a searchable recent-project popover with a current-project checkmark,
  cover, date, quick new-project action and link to the full project library.
- A persistent back arrow opens My Assets / My Projects. A persistent plus creates a project.
- New project means a separate chat, canvas and creation record. Enter the canvas layout
  immediately; do not return the user to the centered welcome composer.
- Preserve an explicitly opened empty project's workspace layout on reload.
- Save the old canvas and draft before switching; leave it open on save failure.
- Reuse a pristine unnamed empty project when New is clicked repeatedly. Draft text,
  references, canvas elements, conversation history or an in-flight submission prohibit reuse.
- Keep using the existing project IDs, project URL routing, canvas persistence,
  scoped drafts and background task delivery. Do not create another asset data model.

The welcome page remains available for an automatically initialized untouched project.
The empty workspace is the existing infinite canvas, without adding a fake fixed-size frame.

## Verification

Project lifecycle regressions cover canvas/draft isolation, save failure, an in-flight
request completing after a switch, empty-project reuse, persisted workspace layout,
and deletion of the current empty project. Browser acceptance uses the actual canvas,
chat and library components with isolated local sample projects.
