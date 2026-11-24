import { describe, expect, it } from 'bun:test'
import { loadDeployment, parseSecretsFile, secretsFromLegacy } from '../deploy-config-cli'

describe('deploy-config-cli', () => {
  it('reads secrets files literally and rejects duplicates', () => {
    expect(parseSecretsFile('# note\nA_KEY=x=y\n\nB_KEY="kept quotes"\n')).toEqual({
      A_KEY: 'x=y',
      B_KEY: '"kept quotes"',
    })
    expect(() => parseSecretsFile('A_KEY=1\nA_KEY=2\n')).toThrow('A_KEY appears twice')
    expect(() => parseSecretsFile('lower=1\n')).toThrow('bad name')
    // CRLF 只去掉行尾，值里的空格保留。
    expect(parseSecretsFile('A_KEY= spaced \r\nB_KEY=x\r\n')).toEqual({
      A_KEY: ' spaced ',
      B_KEY: 'x',
    })
  })

  it('decodes legacy values the way compose read them, CRLF files included', () => {
    const { secrets } = secretsFromLegacy({
      appEnv: 'S3_SECRET_ACCESS_KEY="ab\\"cd\\\\e"\r\nRESEND_API_KEY=\'lit\\eral\'\r\n',
      migrateEnv: '',
    })
    expect(secrets).toEqual({ S3_SECRET_ACCESS_KEY: 'ab"cd\\e', RESEND_API_KEY: 'lit\\eral' })
  })

  it('pulls the catalog secrets out of the legacy layout, database passwords included', () => {
    const { secrets, ignored } = secretsFromLegacy({
      appEnv: [
        'export S3_SECRET_ACCESS_KEY="s3-secret"',
        'APP_DATABASE_URL=postgresql://app:p%40ss@postgres:5432/db',
        'ADMIN_DATABASE_URL=postgresql://admin:ro@postgres:5432/db',
        'RESEND_API_KEY=',
        'AGENT_CHAT_MODEL=gpt-6-luna',
      ].join('\n'),
      migrateEnv: 'MIGRATOR_DATABASE_URL=postgresql://migrator:owner@postgres:5432/db\n',
      tunnelCredentials: '{ "TunnelID": "t", "TunnelSecret": "s" }',
    })
    expect(secrets).toEqual({
      S3_SECRET_ACCESS_KEY: 's3-secret',
      POSTGRES_APP_PASSWORD: 'p@ss',
      POSTGRES_ADMIN_PASSWORD: 'ro',
      POSTGRES_MIGRATOR_PASSWORD: 'owner',
      TUNNEL_CREDENTIALS: '{"TunnelID":"t","TunnelSecret":"s"}',
    })
    expect(ignored).toContain('AGENT_CHAT_MODEL')
  })

  it('loads the descriptors that ship with the repo', async () => {
    expect((await loadDeployment('prod')).legacy.composeProject).toBe('image-playground-paid')
    expect((await loadDeployment('test')).observability).toBeUndefined()
  })
})
