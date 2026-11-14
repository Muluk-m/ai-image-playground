# 浏览器场景套件

追踪票 #1847。状态与时序类的 bug（刷新恢复、多标签页、同步竞争）单元测试覆盖不到，这套场景在真实浏览器里跑
工作台主路径。目前只告警、不挡任何发布或合并，稳定两周后再讨论是否进门禁。

## 它是什么

一次运行在本机或 runner 上起一个完整的本地栈，再用 Playwright 驱动 Chromium：

- PostgreSQL 里的一个临时库（每次运行新建、结束删除），迁移跑真实迁移；
- BFF 与 worker 两个真实进程，跑仓库源码；运营配置只开账号登录与自助注册，渠道清单只有一个指向 mock 的渠道；
- 构建好的 `apps/web/dist`，由 BFF 同源托管；
- [`scripts/e2e/mock-upstream.ts`](../../scripts/e2e/mock-upstream.ts)：可复用的 mock 上游。图片上游讲 BFF 走通用网关时的
  OpenAI Images 协议（`/v1/images/generations` JSON、`/v1/images/edits` multipart），返回确定性纯色 PNG，可配延迟
  （`delayMs`）与失败（`failNext`、`failStatus`），记录每个请求（模型、提示词、尺寸、参考图文件与哈希）供断言；
  同一个模块里还有内存版 S3 子集，替代 BFF 要用的对象存储。

测试账号走真实的 `/api/auth/register` 注册，cookie 由浏览器自己保存，鉴权逻辑没有被绕过。不连外网，不花上游的钱。

## 场景

| 场景 | 文件 | 断言 |
| --- | --- | --- |
| 生成中刷新 | `scripts/e2e/scenarios/refresh-while-generating.ts` | 上游慢回时刷新；任务仍在进行，结果最终出现；上游只收到 1 次请求 |
| 参考图改图 | `scripts/e2e/scenarios/reference-edit.ts` | 上游收到的是改图请求，带参考图文件 |
| 坏参考图 | `scripts/e2e/scenarios/broken-reference.ts` | 截断的 PNG 在前端被标红、生成禁用、上游零请求；移除后换好图重试成功 |
| 发版后旧标签页 | `scripts/e2e/scenarios/stale-tab-release.ts` | 页面打开后「发版」（`publishNewRelease` 换掉哈希文件名），点进未加载过的页面：只自动刷新一次，最终看到目标页，不停在加载失败卡片 |
| 分片两次偶发失败 | `scripts/e2e/scenarios/chunk-failure-twice.ts` | 同一构建里间隔稳定运行后，两次打断懒加载分片（与发版无关）：每次都只自动刷新一次并恢复，不停在失败画面 |
| 路由样式表缺失 | `scripts/e2e/scenarios/route-css-missing.ts` | 路由分片下载成功但它的 CSS 404（`Unable to preload CSS`）：只自动刷新一次并打开目标页，不停在失败卡片 |

坏参考图的拦截发生在前端（`apps/web/src/lib/unusableReferences.ts`），不是 BFF；场景因此只断言「上游没有收到请求」，
不检查扣费（本栈没开积分）。

加场景：在 `scripts/e2e/scenarios/` 新增一个导出 `Scenario` 的文件，登记进 `scripts/e2e/run.ts` 的 `SCENARIOS`。
需要多个标签页或多设备时，对同一个场景多次调用 `newSession(label)`，每次一个独立的浏览器上下文和账号。

## 本地运行

只在云端或 runner 上跑完整套件（需要 PostgreSQL 和构建）。本机不启动 Docker、不做全量构建，按全局约定交给 macmini2
或 CI；要复现某个场景，在有 PostgreSQL 的机器上：

```sh
pnpm --dir apps/web build:static-host   # BFF_ENABLED=true BFF_BASE_URL=http://127.0.0.1:37377（占位，套件按实际端口改写 dist 副本）
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/aip_test pnpm e2e:scenarios --only reference-edit
```

Playwright 版本与 Chromium 由 [`scripts/pages-browser-smoke.sh`](../../scripts/pages-browser-smoke.sh) 固定并安装在仓库外，
`scripts/e2e-scenarios.sh` 经它的 `--run` 复用同一份运行时。环境变量：`E2E_DATABASE_URL`（缺省取 `TEST_DATABASE_URL`，
需要能建库）、`E2E_OUT_DIR`（日志、截图、trace，缺省 `artifacts/e2e`）、`E2E_WEB_DIST`。

## CI

一个 workflow：[`.github/workflows/e2e-scenarios.yml`](../../.github/workflows/e2e-scenarios.yml)，共用的步骤在
[`.github/actions/e2e-scenarios`](../../.github/actions/e2e-scenarios/action.yml)。

- PR 改到 `scripts/e2e/**`、入口脚本、`pages-browser-smoke.sh` 或这个 workflow/action 时触发。
- 推送 `test` 分支时触发，先等同一提交的 `Deploy test` 成功（失败或取消就不跑），再在 runner 上跑，不打真实测试环境。
  它不放在 `deploy-test.yml` 里：那个 workflow 整体共用 `test-deploy` 并发组，套件会拖住下一次测试发布；
  也不用 `workflow_run`：它在默认分支上下文里检出 test 分支的代码，CodeQL 判为缓存投毒。
- 也支持手动触发。
- `continue-on-error: true`，只告警；失败时上传 `browser-scenarios` artifact：`bff.log`、`worker.log`、
  每个失败场景的截图、Playwright trace（`npx playwright show-trace`）和 mock 记录到的上游请求。

类型检查：`scripts/e2e/tsconfig.json` 已接进根目录的 `pnpm typecheck`。

## 相关

[测试环境手册](../deploy/test-environment.md) · [云端测试入口](cloud-tests.md) · 追踪票 #1844 / #1847
