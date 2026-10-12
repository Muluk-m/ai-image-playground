export type CreationMode = 'agent' | 'image' | 'video'
export type CreationLayout = 'A' | 'B' | 'C'
export interface CreationReference {
  id: string
  name: string
  src: string
  kind: 'image' | 'video'
}
export interface CreationParameter {
  id: string
  label: string
  options: readonly string[]
  initial: string
}
export interface CreationModel {
  id: string
  name: string
  description: string
  parameters: readonly CreationParameter[]
}
export type CreationCatalog = Record<CreationMode, readonly CreationModel[]>
export interface CreationSelection {
  model: string
  values: Record<string, string>
}
export interface CreationDraft {
  mode: CreationMode
  text: string
  references: CreationReference[]
  selections: Record<CreationMode, CreationSelection>
}
export function modelDefaults(model: CreationModel): CreationSelection {
  return {
    model: model.id,
    values: Object.fromEntries(model.parameters.map((p) => [p.id, p.initial])),
  }
}
export function createCreationDraft(catalog: CreationCatalog): CreationDraft {
  return {
    mode: 'image',
    text: '',
    references: [],
    selections: {
      agent: modelDefaults(catalog.agent[0]),
      image: modelDefaults(catalog.image[0]),
      video: modelDefaults(catalog.video[0]),
    },
  }
}
export type DraftAction =
  | { type: 'mode'; mode: CreationMode }
  | { type: 'text'; text: string }
  | { type: 'references'; references: CreationReference[] }
  | { type: 'model'; model: CreationModel }
  | { type: 'parameter'; id: string; value: string }

// Content belongs to the draft; model and parameter choices belong to a creation type.
export function creationDraftReducer(state: CreationDraft, action: DraftAction): CreationDraft {
  switch (action.type) {
    case 'mode':
      return { ...state, mode: action.mode }
    case 'text':
      return { ...state, text: action.text }
    case 'references':
      return { ...state, references: action.references }
    case 'model':
      return {
        ...state,
        selections: { ...state.selections, [state.mode]: modelDefaults(action.model) },
      }
    case 'parameter':
      return {
        ...state,
        selections: {
          ...state.selections,
          [state.mode]: {
            ...state.selections[state.mode],
            values: { ...state.selections[state.mode].values, [action.id]: action.value },
          },
        },
      }
  }
}
