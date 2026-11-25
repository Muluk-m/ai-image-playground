# 独立测试环境

`test` 分支经 Deploy test workflow 发布 https://test.muvloom.online。公开代码从工作分支合入测试分支，不在 test 直接开发，不把 test 合回工作分支或 main。此链路不发布生产。

## 资源与隔离

| 资源 | 测试目标 |
| --- | --- |
| Pages | `muvloom-test` / `test.muvloom.online` |
| BFF | `test-api.muvloom.online` |
| VPS Compose 项目 | `image-playground-test` |
| 数据库 | `aip_test`，独立 migrator / app / readonly 角色 |
| R2 | `muvloom-test`，仅此桶的读写凭据 |
| Tunnel | 独立 `muvloom-test-vps`，不改生产 ingress |
| 应用配置 | 仓库外 `apps/image-playground-test/` |

共用 VPS 和 PostgreSQL 进程，不复制生产业务库。账号、会话、生成记录、积分账本和媒体全部独立。测试用户通过密码注册，不继承生产登录；运营配置独立维护。上游生成调用仍有真实供应商成本，验收只做受控小样。

原先测试站连接生产 API；新发布链路**拒绝**该配置，不能自动回退。`check-test-isolation.sh` 在 Pages 发布前检查固定项目、域名、API 与 origin override；后端收包前检查独立数据库、存储、认证地址及密钥不复用生产值。R2 凭据必须从 Cloudflare 创建为仅访问测试桶，不能仅靠不同 prefix。

后端 `runtime` 模式按 `docker run/create --env-file` 解释 `app.env` / `migrate.env`（与 `rollout-runtime.sh` 一致）：值是字面量，不剥首尾引号、不展开变量，值尾空白保留；行尾 `\r\n` 与首行 BOM 去掉，行首空白去掉，空行与 `#` 注释忽略，同名键取最后一次。没有 `=` 的行（Docker 会从宿主环境继承）、变量名为空或含空白的行直接拒绝，不当作未设置。不要给这些文件写成 shell 引号形式，否则检查器与容器里看到的字符串会带上引号本身。Pages 模式仍用 shell `source`，只用于 CI 的 pages env。

## 配置中心模式（ADR 0035）

部署描述 `deploy/deployments/test.json` 的 `configSource` 为 `rendered` 时，test 用配置中心，不再读 `apps/image-playground-test/` 下的 `app.env`、`migrate.env`、`operator-config.json` 和 `cloudflared/`；为 `legacy` 时读 `app.env`。发布脚本只看这个字段，VPS 上有没有生成目录不影响判断。

- **启用 / 回退**：改 `configSource` 的 PR，合入 main 后下一次 test 发布生效（test 执行 main 上的发布脚本和部署描述）。
- **核对**：发布日志里会打出 `Configuration source: <来源>`；`rendered` 时发布后逐个确认执行器带有生成配置的摘要标签，没有就判发布失败。`/health` 的 `config.source`、`config.digest` 报告线上执行器实际用的配置。
- **每次发布**：`vps-deploy.sh` 先用发布镜像跑 `scripts/config-render.sh test image-playground-test <镜像>`，再按生成目录跑 `check-test-isolation.sh runtime <生成目录>`；两步都在改动服务和数据库之前。
  - `config-render.sh` 凭 `~/.config/ai-image-playground/bootstrap.env` 里 test 的 Access token，从 Config Worker 取密钥，非密钥配置取自镜像里的 `deploy/deployments/test.json`。
  - 隔离检查先确认参与核对的键在各服务的 env 里取值一致（`APP_ROLE`、`PORT` 这类按服务不同的键不算），再合在一起核对；生产凭据按生产实际使用的位置比对（生产启用配置中心后读它的生成目录，否则读 `apps/image-playground-paid/app.env`）。
- **生成目录**（0700，文件 0600）：
  - `deploy.env`：项目名、端口、开关，不含密钥；
  - `env/<服务>.env`：每个服务只有自己登记过的键，按字面读取；
  - `operator-config.json`；
  - `cloudflared/main/{config.yml,credentials.json}`。
- **改配置**：非密钥配置改 `deploy/deployments/test.json`，走 PR。密钥用 `deploy/config-worker/provision.ts secrets push test <文件>` 写进 Secrets Store。
- **Tunnel**：生成目录每次渲染都整体替换，连接器挂不住，所以连接器挂的是 `~/.config/ai-image-playground/tunnels/<项目>/<main|enterprise>/`。发布时先把生成的 `config.yml`、`credentials.json` 原地写进去，再按情况处理连接器：
  - 挂着旧目录或没在运行：重建；
  - 文件有变化（包括只轮换了凭据）：重启；
  - 重建或重启后最多等 60 秒，直到连接器日志出现 `Registered tunnel connection`（已连上 Cloudflare 边缘）；连接器退出或超时都算发布失败。
  - 文件写入前先留下 `tunnels/<项目>/.pending-<名称>` 标记，连接器带着新文件就绪后才删除。发布中途失败时，下一次发布仍会重启连接器。
  - 连接器以发布用户的身份运行，所以 0600 的文件不需要额外开放读权限。
  - 部署描述里去掉 `tunnels.enterprise`，或回退到 `app.env` 时，删除本项目的企业连接器；回退时主连接器重新挂回 `apps/<项目>/cloudflared`。
- **首次安装**：生成的配置把 Tunnel、Admin、宿主采样都指向发布路由器，而路由器要第一次滚动发布之后才有。所以配置中心模式下拒绝首次安装，新机器先用 `app.env` 发布一次（P6 的 `bootstrap-host.sh` 会接管）。
- **只改配置**：执行器带着 `app.runtime.config` 标签（bff、worker 的 env 和 operator 配置的摘要）。镜像不变但重新渲染后摘要变了（例如轮换了密钥），发布会按新一代滚动，而不是沿用当前执行器。
- **分割服务**：接不接入由部署描述的 `segmenter` 决定（渲染进 `deploy.env` 的 `SEGMENTER_ENABLED`），宿主机上的 `SEGMENTER_EDITIONS` 只对 `app.env` 模式生效。
- **回滚**：`app-compose.sh rollback` 先用回滚镜像重新渲染；旧镜像没有渲染命令时，沿用当前的生成目录并给出告警。

## 发布链路

1. 后端镜像构建（含 `scripts/ci-check-test-branch.sh`：落后 main 即失败）与门禁并行启动，镜像只是私有 GHCR 里的数据，门禁没过不会发布。推 test 一律运行 `scripts/test-sync.sh [分支 ...]`：先确认每个分支的推送提交 Web checks 已过门禁要的 job（没跑过就派发并等待），再在临时 worktree 里把 `origin/main` 和这些分支合进 `origin/test` 并推送；main 中途前进或 test 被别人抢推时自动重合，不动任何工作区，已在 test 上的提交都保留；有冲突就中止、什么都不推，需要人工解决。细节见[发布手册](../agents/release.md)「二」。
2. 门禁先看同一提交的 `Web checks`：推 `test` 也会触发 web.yml，`verify` job（`scripts/ci-reuse-web-checks.sh`）等该 run 结束，只有 event 为 push、分支 `test`、`head_sha` 就是本次提交，且 `lint`、`typecheck`（含 Admin 构建）、`build`（含 Chromium 首页/项目深链接启动检查）、`deploy-integration`（真 Docker 发布集成检查）、`bff` 四片（含计费数据库测试）、`web-test` 三片（共 11 个 job）全部 success，才复用，不再重跑。没有 run、有 job 失败或缺失（含 web.yml 改名）、等超时（25 分钟）都不复用，回落到本 workflow 自带的 `Checks` / `Tests` / `Web tests`，与复用前覆盖项一致（单仓 lint / typecheck / 完整测试、真 Docker 发布集成检查与构建及 Chromium 启动检查）。`web.yml` 改 job 名要同步改脚本里的 `REQUIRED`，否则只会回落、不会放行。
3. 门禁通过后（复用或回落全绿）才进入 `rollout`：SSH receiver 接受 `deploy <release-id> test <run-id>`，digest 校验后只向 `image-playground-test` 发布。复用迁移、依赖检查、不可变运行时和排空协议；VPS 不构建。
4. API `/health` 返回本次提交版本（`<sha>+<sha>` 或 `<sha>`）后，才构建同一提交的测试前端；最终 `dist` 通过浏览器启动检查后才上传，上传后再验证测试域名的首页与项目深链接。
5. 核验线上 `version.json`、TLS、CORS、登录、授权媒体与一次真实生成。

GitHub 使用已有 VPS 与 Cloudflare secrets。CI 在读取 `PAGES_ENV` 后固定覆盖测试 API 为 `https://test-api.muvloom.online` 并清空 origin override，无需重写共享生产 secret 的 API 地址。共享 `PAGES_ENV` 与仓库外 `pages.env` 中的企业配置须使用 `ENTERPRISE_PUBLIC_ORIGIN` / `ENTERPRISE_BFF_BASE_URL`；旧键没有 fallback，更新前提见[部署手册](image-release.md#仓库外更新前提)。本机 `TEST_BFF_BASE_URL` 也必须使用测试 API 地址。测试使用单独 SSH key（secret `VPS_SSH_KEY_TEST`），在 VPS 绑定 `aip-ci-receive test`，只能发布 `test`；生产 key 绑定 `aip-ci-receive release`，只能发布 `paid`。`test` 镜像来自 `test` 分支本身，但宿主机执行的部署脚本由 receiver 自动从公开仓库 `main` 最新提交解出（不执行未合入 `main` 的分支脚本）；`~/bin/aip-ci-receive` 自身也随 `main` 自动更新（备份旧版后替换，下一次发布生效）。

发布成功后，独立的 `Browser scenarios` workflow（推送 `test` 时触发并等待发布成功）会在 runner 上用本地栈和 mock 上游跑一遍浏览器场景套件，只告警、不占用 `test-deploy` 并发组，见[浏览器场景套件](../agents/browser-scenarios.md)。

## 首次配置

在已有 VPS 配置根创建 `apps/image-playground-test/`，放置独立 `app.env`、`migrate.env`、`operator-config.json` 和 `cloudflared/{config.yml,credentials.json}`。角色命名为 `aip_test_app` / `aip_test_admin` / `aip_test_migrator`，数据库固定 `aip_test`。用既有 `infra-compose.sh provision` 和独立 provision env 创建角色与空库，不重启共享 PostgreSQL。

设置 `S3_BUCKET=muvloom-test`；独立生成内部令牌、Cookie/验证码密钥；认证 origin 为测试域名；CORS 精确为 `https://test.muvloom.online,https://muvloom-test.pages.dev`；运营告警 webhook 留空。不得复制生产 OAuth 回调、用户或余额。

首次启动先依赖检查和迁移，再启动 BFF/worker、独立 Tunnel。后续版本自动走 runtime rollout。业务能力由 BFF 运营配置控制，不写入前端 runtime-config。

## 回滚与验收记录

保留上一份 release 目录及 test 镜像；只对 `image-playground-test` 使用既有 `app-compose.sh rollback`，等待排空，不能强停在途任务。数据库迁移保持向前兼容；不以恢复备份覆盖测试新数据。前端回到与后端同组源码和 overlay 的受检提交，通过测试发布链路交付。

每次验收记录公开 SHA、overlay SHA、image digest、迁移版本、前端 version、测试账号标识、生成任务 ID、媒体授权结果和费用账本归属。部署日志仅证明 rollout，不能替代浏览器验收。首次环境没有上一测试版本时，不声称回滚已验证；第二版交付时补齐前后切换证据。

## 首次准备状态（2026-10-01）

已在现有账号/主机创建测试 R2 桶、限定桶权限的凭据、独立 Tunnel/DNS、空数据库与三类角色，配置文件放在上述仓库外目录。当时实测测试桶写入/读取/删除成功，对生产桶访问返回 `AccessDenied`；测试 app/migrator 对当时两个生产库业务表的读写授权计数均为 0。此为 2026-10-01 历史隔离证据，不证明后续配置持续不变。共享 PostgreSQL 的默认 CONNECT 不等于业务表授权，未修改生产 ACL。

这只是基础设施准备记录：尚未据此宣称测试 BFF 上线、登录/生成验收或回滚通过。首次代码发布须跟随本次集成提交 CI，最后在测试站补齐完整验收记录。
