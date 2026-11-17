import { Elysia } from 'elysia'
import { bffDrain } from '../lib/drain'
import { requireInternalService } from '../lib/user-auth'

export const internalDrainRoutes = new Elysia({ prefix: '/internal/deployment' })
  .use(requireInternalService)
  .get('/drain', () => bffDrain.status())
  .post('/drain', () => {
    bffDrain.begin()
    return bffDrain.status()
  })
