# 云端测试入口

入口保存在仓库中，不依赖 `/workspace/cloud-prep/test.sh` 或某个会话的辅助文件。
需要 Node 24、仓库 `packageManager` 指定的 pnpm、Bun 和 Python 3。

## Codex Cloud 内

```sh
python3 scripts/cloud-test.py prepare
python3 scripts/cloud-test.py check
python3 scripts/cloud-test.py web --filter canvas-document
python3 scripts/cloud-test.py bff --filter /routes/channels.test.ts
python3 scripts/cloud-test.py db
python3 scripts/cloud-test.py down
```

`prepare` 使用 `pnpm install --frozen-lockfile`，不会重写锁文件。只有当前锁文件、
各包 manifest、工具版本与已安装依赖记录均匹配时才复用缓存。测试命令自动执行 prepare；
恢复后记录缺失也会重新验证安装。每个 checkout 同时只允许一个入口修改依赖或运行测试。

`check` 只检查工具和已验证的依赖，不要求前端、BFF 或数据库已启动。
`--sha <完整提交 SHA>` 在安装、启动数据库和测试前核对实际提交，不匹配立即停止。
错误前缀区分 revision、environment、tools、dependencies、database、tests 和 dispatch。

BFF/DB 测试按仓库现有 runner 逐文件隔离。默认仅启动专用 PostgreSQL 测试容器，
使用动态 localhost 端口和 tmpfs；进程和容器重启后可重新创建，不依赖旧运行进程。
镜像固定 digest，启动使用 `--pull never`；母版需预装 compose 文件中的官方镜像。
缺镜像或 Docker 权限时报告 database 错误。`down` 仅停止当前 checkout 的测试容器。

测试进程使用空 HOME、白名单环境和禁用 dotenv 的入口，不继承模型/生产凭据；
不启动应用后台或 worker。安装阶段保留平台代理与 CA，使用空 npm 用户配置。
本入口覆盖公开树；私有 overlay 验收继续使用既有 CI `with-overlay` job。

## 本机提交云端测试

先提交并推送工作分支，再执行：

```sh
python3 scripts/cloud-test.py submit --target db
python3 scripts/cloud-test.py submit --target web --filter canvas-document
gh run list --workflow cloud-tests.yml
gh run watch <run-id> --exit-status
gh run view <run-id> --log-failed
```

该入口使用已有 GitHub CLI 认证触发 `Cloud tests`，核对远端分支与本机 HEAD 一致，
工作流按完整 SHA 检出并再次核对。提交成功只代表排队；以该 SHA 的运行结果判断通过。
修改本入口的 PR 也会自动运行同一工作流的 DB 测试，验证恢复和执行路径。
它不修改其他 Codex 会话的环境绑定，不依赖 `codex cloud` 的登录状态。
新工作流首次使用前需先合入默认分支。托管 Cloud 绑定不可用时可用这一 CI 执行路径，
不回退本机跑重任务，也不把 GitHub 认证与 Codex Cloud 认证混为一谈。

GitHub CLI 的身份必须对目标仓库有 Actions 写权限；仓库可读不代表能够派发工作流。
若返回 401/403，报告 dispatch 阶段和当前账号，由平台修正 CLI 绑定；不要新增 token
或把连接器的凭据复制到 shell。连接器与 CLI 可能绑定不同账号，需分别验证。
