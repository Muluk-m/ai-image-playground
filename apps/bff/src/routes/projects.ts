import {
  isProjectWrite,
  PROJECT_DOCUMENT_MAX_BYTES,
  PROJECT_PAGE_MAX_SIZE,
  PROJECT_PAGE_SIZE,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { listProjects, readProject, writeProject } from '../lib/projects'
import { resolveAuthUser } from '../lib/user-auth'

const id = t.String({ format: 'uuid' })

async function readWrite(request: Request): Promise<unknown> {
  const budget =
    Math.min(PROJECT_DOCUMENT_MAX_BYTES, config.operator.quotas['sync:project-document-bytes']) +
    2048
  if (Number(request.headers.get('content-length')) > budget) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > budget) {
        await reader.cancel()
        return null
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}
export const projectRoutes = new Elysia()
  .onError({ as: 'scoped' }, ({ code, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_project_request' }
    }
  })
  .use(resolveAuthUser)
  .onBeforeHandle(({ set }) => {
    set.headers['cache-control'] = 'private, no-store'
    if (!isCapabilityEnabled('accounts:sync')) return capabilityUnavailable('accounts:sync')
  })
  .get(
    '/api/projects',
    async ({ authUser, query, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return listProjects(authUser.id, query.limit ?? PROJECT_PAGE_SIZE, query.cursor)
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: PROJECT_PAGE_MAX_SIZE, multipleOf: 1 })),
        cursor: t.Optional(id),
      }),
    },
  )
  .get(
    '/api/projects/:id',
    async ({ authUser, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const project = await readProject(authUser.id, params.id)
      return project ?? status(404, { error: 'project_not_found' })
    },
    { params: t.Object({ id }) },
  )
  .put(
    '/api/projects/:id',
    async ({ authUser, params, request, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const body = await readWrite(request)
      if (!isProjectWrite(body)) return status(400, { error: 'invalid_project_document' })
      if (
        Buffer.byteLength(JSON.stringify(body.document)) >
          config.operator.quotas['sync:project-document-bytes'] ||
        body.document.elements.length > config.operator.quotas['sync:project-elements']
      )
        return status(413, { error: 'project_document_too_large' })
      const result = await writeProject(authUser.id, params.id, body)
      return result.ok
        ? result.project
        : status(result.status, {
            error: result.error,
            ...('revision' in result ? { revision: result.revision } : {}),
          })
    },
    { params: t.Object({ id }), parse: 'none' },
  )
