# 0035：配置中心——仓库里一份清单，密钥放 Cloudflare Secrets Store，发布时按服务生成

日期：2026-11-24。状态：已接受（Nain 2026-11-24 选定：密钥用 Cloudflare Secrets Store + Config Worker，非密钥配置放仓库）。关联：ADR 0033，docs/deploy/image-release.md，docs/deploy/cold-recovery.md。

## 现状

2026-11-24 盘点：代码、compose、脚本和示例文件里一共出现 256 个变量名，代码运行时实际读取 127 个。

- **来源零碎。** 一个部署要拼起来，需要 VPS 上的 `app.env`、`migrate.env`、`infra.env`、`infra.paid.env`、`provision.env`、`deploy.env`、`operator-config.json`、`cloudflared/`、`ghcr-pull-token`，GitHub Secret `PAGES_ENV`（整份 `pages.env`），再加上仓库里 8 份手抄的 `*.env.example`。这些文件没有一份是完整的，彼此也对不上：生产 `app.env` 有 89 个键，测试环境有 61 个，差异是不是故意的，没有任何检查说得清。
- **同一个值存了好几份。** 数据库密码在 `infra.env` 里存一份，又在 4 个连接串里各拼一遍。域名一共 10 个变量（`AUTH_*_ORIGIN(S)`、`CORS_*`、`ADMIN_*_ORIGIN`、`PUBLIC_WEB_ORIGIN`、`BFF_BASE_URL`、`PAGES_ENV` 里的 `*_PUBLIC_ORIGIN`），加一个域名要改五六处。
- **所有容器共用一个 `app.env`。** bff、worker、admin、web、migrate 都能读到日志库 root 密码等与自己无关的密钥（#1971 只是在环境里把它们置空，挡不住直接读挂载进来的文件）。
- **死键和副本。** 生产 `app.env` 里有 4 个键代码已经不读了。VPS 上有 103 份 `*.bak*` 备份，每份都是带密钥的完整副本，轮换密钥时不会跟着变。`internal` 部署已经停用，但整套配置还留着。
- **名字过时。** 「paid」「internal」「enterprise」这几套部署早已合成一个生产后端，名字却还留在目录、compose 项目、`PAID_*` 键和发布脚本里。
- **迁移靠手工。** 换一台机器，要照着手册把上面这些文件逐个拷过去，再手工核对。

## 决定

只有两套部署：**`prod`**（muvloom 和企业域名共用的生产后端）和 **`test`**。配置分三层：一份清单定义所有配置项，非密钥的值放仓库，密钥放远程。

1. **唯一清单：`packages/shared/src/deploy-config`。** 每个配置项只在这里登记一次，写明：容器里的变量名，给哪些服务用，值从哪来（仓库里的部署描述、远程密钥、由其他项推导、或者固定值），是否必填，默认值，一句说明。示例文件、Worker 的 binding 列表、发布时生成的各服务 env，都由这份清单生成，不再手抄。`pnpm lint` 检查代码、compose 和脚本有没有用到清单外的变量。
2. **非密钥的值进仓库：`deploy/deployments/<prod|test>.json`。** 包括域名、Pages 项目、存储桶、模型、并发、开关和 operator 设置（capabilities / quotas），按业务领域分组，键名用 lowerCamelCase。改动走 PR，有审查和历史。GitHub Actions 发布 Pages 时也读这份文件，`PAGES_ENV` 退役。域名只登记一次，CORS、OAuth 回调、Admin 来源等 10 个变量都由它推导。
3. **密钥放 Cloudflare Secrets Store（Nain 个人账号）。** 命名为 `<部署>__<变量名>`，例如 `PROD__S3_SECRET_ACCESS_KEY`。Secrets Store 只能写入，API 和 Dashboard 都读不回明文，有审计日志；配额是每账号 100 个，两套部署合计约 60 个。只有 Worker 能通过 binding 读到值，所以新增 **Config Worker**（`deploy/config-worker`，`config.nainma.online`）：
   - 前面挂 Cloudflare Access，`/prod` 和 `/test` 各有一个 Access 应用，各自只放行本部署的 service token；Worker 再校验一遍 Access JWT 的 `aud`，测试环境的 token 拿不到生产密钥。
   - 只返回所请求部署的密钥，不提供写接口。改密钥用 Dashboard 或 `wrangler secrets-store`。
   - binding 列表由清单生成，CI 检查生成结果和仓库里的文件一致。
4. **主机上只放一个文件：`~/.config/ai-image-playground/bootstrap.env`。** 内容是 Config Worker 地址和本机各部署的 Access service token。这是「第一个凭据」，任何远程拉取方案都绕不开它。
5. **发布时按服务生成配置。** 用要发布的镜像跑一次 `config render <部署>`，所以清单版本和代码版本始终一致。它会：
   - 读部署描述，向 Config Worker 拉密钥，按清单校验，缺必填项就在切换流量之前失败；
   - 原子写入 `~/.config/ai-image-playground/<部署>/rendered/`（目录 0700、文件 0600），内容包括每个服务一份 env（bff、worker、admin、web、migrate、pg-backup、host-collector、obs-proxy、openobserve、otel-collector、cloudflared、postgres……），以及 `operator-config.json`；
   - 每个服务只拿到自己声明过的键。

   compose 和 `rollout-runtime.sh` 只引用生成后的文件，不再有容器加载整份 `app.env`。生成结果留在本机，所以容器重启和宿主机重启都不依赖 Cloudflare；Cloudflare 或 Access 不可用时，只影响发新版和迁移，不影响线上运行。
   另外生成 `deploy.env`（compose 项目名、端口、开关，给发布脚本和 compose 插值用，不含密钥）和每个 Tunnel 的 `cloudflared/<main|enterprise>/{config.yml,credentials.json}`：主机名到服务的路由写在部署描述 `tunnels` 里，凭据是 `TUNNEL_CREDENTIALS` / `ENTERPRISE_TUNNEL_CREDENTIALS`。分割服务地址仍由 `vps-deploy.sh` 按分割服务是否健康注入。
   宿主机级密钥（共享 PostgreSQL 超级用户、GHCR 拉取令牌）以 `HOST__` 开头，`config render-host` 生成；Access 应用 `aip-config host` 只放行 prod 的 token，test 的 token 读不到。
6. **统一读取。** 业务代码只通过 `packages/shared/src/deploy-config` 按服务导出的类型化配置读取，默认值只写在清单里；lint 禁止在测试和构建脚本以外直接读 `process.env`。业务参数（并发、限流、价格、超时）随部署描述走 PR，不再散在 env 里。
7. **一键起新机器：`scripts/bootstrap-host.sh <部署>`。** 依次：装 Docker → 写 `bootstrap.env` → 拉镜像 → `config render` → 启动 infra → （可选）从 R2 恢复数据库 → 启动应用和 Tunnel → 冒烟。冷恢复包只需要数据库和镜像，配置文件不再需要单独打包。

## 放弃的方案

- **GitHub Secrets 当密钥源。** 只有 workflow 运行时才存在。容器重启、宿主机重启、冷恢复都不经过 GitHub，最后还是要落到主机上；而且 GitHub 也会因此持有生产数据库和日志库的密码。
- **所有配置都放 VPS 上的一个文件。** Actions 读不到它，域名还得在 `PAGES_ENV` 里再存一份；改动没有审查和历史。
- **SOPS/age 加密文件放 R2。** 是成熟方案，也能离线解密，但编辑要靠命令行，主机上要放两个凭据，也没有审计和 Dashboard。Secrets Store 是公开测试版，这是我们接受的风险：Worker 的接口很简单，需要时可以把 Worker 背后的存储换成 R2 上的 SOPS 文件，主机和 render 都不用改。
- **容器启动时直接从远程拉配置、本机不落盘。** 这样 Cloudflare 一出问题，容器连重启都起不来。

## 迁移顺序

每一步都兼容旧布局，可以单独回退。

1. **P1 清单。** 新增清单 `packages/shared/src/deploy-config`、`deploy/deployments/{prod,test}.json`、`config render`（先支持从本地文件读密钥）和 lint 检查，示例文件改为生成。线上不变。
2. **P2 Config Worker。** Worker、Access 应用和 service token 建在 Nain 个人 Cloudflare 账号下。在 VPS 上用脚本把现有密钥写入 Secrets Store，值不经过终端输出和日志。
3. **P3 发布改用生成的配置。** 先切 test，验证后再切 prod。旧的 `app.env` 留作回退，确认没问题后再删。
4. **P4 统一读取。** 业务代码改为通过清单读取，默认值收进清单，lint 禁止散读 `process.env`。
5. **P5 Pages。** 改为从部署描述读取配置，`PAGES_ENV` 和 `PAID_*` 退役。
6. **P6 一键起机。** 写 `bootstrap-host.sh`，在 macmini2 上用 test 从零演练一次。
7. **P7 清理（改生产，需 Nain 批准）。** 删除旧配置文件、103 份备份（先加密归档到 R2）、`internal` 目录和 4 个死键，轮换已经暴露过的密钥，把 compose 项目 `image-playground-paid` 改名为 `image-playground-prod`（迁移数据卷，需要短暂停机）。
