/**
 * Domain-scoped PostgreSQL schema barrel (ADR 0034).
 * Re-exports every table, view, and row type from `packages/db/src/schemas/*`
 * so existing callers and `drizzle.config.ts` keep a single stable import path.
 */
export * from './schemas/agent'
export * from './schemas/agent-orchestration'
export * from './schemas/canvas'
export * from './schemas/catalog'
export * from './schemas/cms'
export * from './schemas/execution'
export * from './schemas/identity'
export * from './schemas/library'
export * from './schemas/media'
export * from './schemas/ops'
