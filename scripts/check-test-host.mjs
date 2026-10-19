import { hostname } from 'node:os'

if (
  process.platform === 'darwin' &&
  hostname().split('.')[0].toLowerCase() === 'qiliangjiademacbook-pro'
) {
  console.error('禁止在这台 MacBook 上运行全量测试。请使用 Codex Cloud、macmini2 或 CI。')
  process.exit(1)
}
