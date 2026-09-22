export const INSPIRATION_KINDS = ['showcase', 'template', 'skill'] as const
export type InspirationKind = (typeof INSPIRATION_KINDS)[number]

export const INSPIRATION_STATUSES = ['draft', 'published', 'archived'] as const
export type InspirationStatus = (typeof INSPIRATION_STATUSES)[number]

export interface InspirationParams {
  size: string
  quality?: 'auto' | 'low' | 'medium' | 'high'
  n?: number
}

export interface InspirationReferenceInput {
  key: string
  name: string
}

export interface InspirationReference {
  url: string
  name: string
}

export interface InspirationItem {
  id: string
  kind: InspirationKind
  title: string
  description?: string
  prompt: string
  thumbnailUrl: string
  imageUrl?: string
  params: InspirationParams
  recommendedModel: string
  recommendedProvider: string
  category: string
  tags?: string[]
  author?: string
  sourceUrl?: string
  featured?: boolean
  referenceImages?: InspirationReference[]
  skill?: string
  slots?: string[]
}

export interface InspirationManifest {
  version: number
  updatedAt: string
  items: InspirationItem[]
  categories?: string[]
}

export interface InspirationAdminItem {
  id: string
  kind: InspirationKind
  status: InspirationStatus
  featured: boolean
  title: string
  description: string | null
  categoryId: string
  prompt: string
  recommendedProvider: string
  recommendedModel: string
  params: InspirationParams
  tags: string[]
  coverKey: string
  imageKey: string | null
  referenceImages: InspirationReferenceInput[]
  skillName: string | null
  sourceUrl: string | null
  author: string | null
  sort: number
  createdAt: number
  updatedAt: number
  updatedBy: string
  publishedAt: number | null
}

export interface InspirationCategory {
  id: string
  name: string
  sort: number
}

export type InspirationWriteInput = Omit<
  InspirationAdminItem,
  'status' | 'createdAt' | 'updatedAt' | 'updatedBy' | 'publishedAt'
>
