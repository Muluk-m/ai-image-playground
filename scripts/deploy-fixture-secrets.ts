/**
 * 部署集成测试用的假密钥：按清单列出某个部署必填的密钥，值是一眼能认出来的假值，
 * Tunnel 凭据给合法的结构。输出 `NAME=value`，交给 `deploy-config-cli.ts render --secrets-file`。
 * prod 与 test 的值互不相同，隔离检查才有意义。不联网、不读任何真实密钥。
 *
 *   bun run scripts/deploy-fixture-secrets.ts <prod|test>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDeployment, SECRETS } from '../packages/shared/src/deploy-config'

const name = process.argv[2]
if (name !== 'prod' && name !== 'test') {
  console.error('usage: deploy-fixture-secrets.ts <prod|test>')
  process.exit(2)
}
const root = join(import.meta.dir, '..')
const deployment = parseDeployment(
  JSON.parse(readFileSync(join(root, 'deploy/deployments', `${name}.json`), 'utf8')),
  `${name}.json`,
)
const tunnelId =
  name === 'prod' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'
const lines: string[] = []
for (const secret of SECRETS) {
  if (!secret.required(deployment)) continue
  const value = secret.name.endsWith('TUNNEL_CREDENTIALS')
    ? JSON.stringify({
        AccountTag: `${name}-account`,
        TunnelID: tunnelId,
        TunnelSecret: `${name}-tunnel-secret`,
      })
    : `${name}-fixture-${secret.name.toLowerCase().replaceAll('_', '-')}`
  lines.push(`${secret.name}=${value}`)
}
process.stdout.write(`${lines.join('\n')}\n`)
