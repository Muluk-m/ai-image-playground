import { expect, it } from 'bun:test'
import { agentTurnFailure } from '../../../lib/agent/turn-failure'

it('keeps error detail and redacts credentials, signed queries and inline images', () => {
  const failure = agentTurnFailure(
    'agent_upstream_error',
    new Error(
      '400 unsupported: Bearer private-token api_key=private-key sk-secretkey data:image/png;base64,abcdef https://image.test/a?signature=private-signature',
    ),
    'fixture',
  )
  expect(failure.message).toContain('400 unsupported')
  for (const secret of [
    'private-token',
    'private-key',
    'sk-secretkey',
    'abcdef',
    'private-signature',
  ])
    expect(failure.message).not.toContain(secret)
  expect(failure.message).toContain('https://image.test/a')
})

it('bounds upstream diagnostic size', () => {
  expect(agentTurnFailure('agent_run_failed', 'x'.repeat(10000), 'fixture').message).toHaveLength(
    4000,
  )
})

it('redacts URL credentials, fragments and complete quoted or Basic credentials', () => {
  const failure = agentTurnFailure(
    'agent_upstream_error',
    '401 https://user:privatepassword@example.com/v1?token=signed#privatefragment Authorization: Basic dXNlcjpwYXNz "password": "my secret value" token=private-token',
    'fixture',
  )
  expect(failure.message).toContain('https://example.com/v1')
  for (const secret of [
    'user:',
    'privatepassword',
    'signed',
    'privatefragment',
    'dXNlcjpwYXNz',
    'my secret value',
    'secret value',
    'private-token',
  ])
    expect(failure.message).not.toContain(secret)
})
