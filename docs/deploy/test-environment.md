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

## 发布链路

1. 检出触发提交，确认不落后 main，执行公开 lint / typecheck / 完整测试与构建。
2. 读取该提交的 `private.lock`，检查带 overlay 的 lint / typecheck；Actions 构建 `test` 镜像并推 GHCR。
3. SSH receiver 接受 `deploy <release-id> test <run-id>`，digest 校验后只向 `image-playground-test` 发布。复用迁移、依赖检查、不可变运行时和排空协议；VPS 不构建。
4. API `/health` 返回公开 SHA + overlay SHA 后，才构建并发布同一对提交的测试前端。
5. 核验线上 `version.json`、TLS、CORS、登录、授权媒体与一次真实生成。

GitHub 使用已有 VPS、Cloudflare 和 overlay secrets。CI 在读取 `PAGES_ENV` 后固定覆盖测试 API 为 `https://test-api.muvloom.online` 并清空 origin override，无需重写共享生产 secret。本机 `pages.env` 的 `TEST_BFF_BASE_URL` 也必须使用该地址。SSH 主机的 `~/bin/aip-ci-receive` 必须先更新为支持 `test` 的接收器；生产调用仍走原目标。

## 首次配置

在已有 VPS 配置根创建 `apps/image-playground-test/`，放置独立 `app.env`、`migrate.env`、`operator-config.json` 和 `cloudflared/{config.yml,credentials.json}`。角色命名为 `aip_test_app` / `aip_test_admin` / `aip_test_migrator`，数据库固定 `aip_test`。用既有 `infra-compose.sh provision` 和独立 provision env 创建角色与空库，不重启共享 PostgreSQL。

设置 `S3_BUCKET=muvloom-test`；独立生成内部令牌、Cookie/验证码密钥；认证 origin 为测试域名；CORS 精确为 `https://test.muvloom.online,https://muvloom-test.pages.dev`；运营告警 webhook 留空。不得复制生产 OAuth 回调、用户或余额。

首次启动先依赖检查和迁移，再启动 BFF/worker、独立 Tunnel。后续版本自动走 runtime rollout。业务能力由 BFF 运营配置控制，不写入前端 runtime-config。

## 回滚与验收记录

保留上一份 release 目录及 test 镜像；只对 `image-playground-test` 使用既有 `app-compose.sh rollback`，等待排空，不能强停在途任务。数据库迁移保持向前兼容；不以恢复备份覆盖测试新数据。前端回到与后端同组源码和 overlay 的受检提交，通过测试发布链路交付。

每次验收记录公开 SHA、overlay SHA、image digest、迁移版本、前端 version、测试账号标识、生成任务 ID、媒体授权结果和费用账本归属。部署日志仅证明 rollout，不能替代浏览器验收。首次环境没有上一测试版本时，不声称回滚已验证；第二版交付时补齐前后切换证据。

## 首次准备状态（2026-10-01）

已在现有账号/主机创建测试 R2 桶、限定桶权限的凭据、独立 Tunnel/DNS、空数据库与三类角色，配置文件放在上述仓库外目录。实测测试桶写入/读取/删除成功，对生产桶访问返回 `AccessDenied`；测试 app/migrator 对两个生产库业务表的读写授权计数均为 0。共享 PostgreSQL 的默认 CONNECT 不等于业务表授权，未修改生产 ACL。

这只是基础设施准备记录：尚未据此宣称测试 BFF 上线、登录/生成验收或回滚通过。首次代码发布须跟随本次集成提交 CI，最后在测试站补齐完整验收记录。
