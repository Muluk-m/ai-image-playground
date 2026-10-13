/** DRAFT legal copy for the owner to review. Do not show the word "draft" in the UI. */

export const TERMS_SECTIONS = [
  'accounts',
  'credits',
  'content',
  'prohibited',
  'ai',
  'contact',
] as const

export const PRIVACY_SECTIONS = ['data', 'cookies', 'providers', 'retention', 'contact'] as const

export type LegalSectionId = (typeof TERMS_SECTIONS)[number] | (typeof PRIVACY_SECTIONS)[number]
