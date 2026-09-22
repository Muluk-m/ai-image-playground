# 发布链剩余脆弱点：`api.github.com/meta` 单点与两仓耦合方式

调研日期：**2026-09-22**。只读调研，**未改动任何 workflow、脚本或代码**，未提交、未开 PR。

三个待答问题（按重要性）：

- **Q1** `deploy.yml:106` / `:220` 两处匿名调 `api.github.com/meta` 拿 github.com 的 SSH host key，无重试，2026-09-22 生产部署因它返回 403 直接挂掉整条 job。限额是多少？runner 里有没有现成的凭证或预置数据能免掉这次调用？官方有没有静态指纹可以写死？业界在 Actions 里 clone 私有仓的首选做法是什么？
- **Q2** 两仓耦合还有没有比 `verified` 分支更标准的做法（`workflow_run` / `repository_dispatch` 跨仓、submodule、私有 npm 包）？
- **Q3** `deploy.yml` 里还有没有同类的「匿名外部依赖 / 无重试」单点？

来源规则：GitHub 官方 REST / Actions 文档、`actions/checkout` 与 `actions/runner-images` 仓库源码、OpenSSH man page。标「**实测**」的是本次在本机或对 GitHub API 现场跑出来的结果（最硬的证据）。凡未验证到的写「未验证」。

---

## 结论先说

**Q1 — 这次网络调用应该整条删掉，而不是加重试。**

- 匿名调 `/meta` 的限额是 **60 次/小时**，且计在**发起 IP** 上（实测 `x-ratelimit-limit: 60`、`x-ratelimit-resource: core`）；带 token 是 **5,000 次/小时**（实测）。GitHub-hosted runner 的出口 IP 不是我们独占的，所以这 60 次是和同一出口 IP 上所有人共享的 —— 超限时 GitHub 返回 **403 或 429 且 `x-ratelimit-remaining: 0`**，这与 9-22 观察到的 403 完全对得上。
- **runner 镜像已经预置了 github.com 的 host key**：`actions/runner-images` 的 ubuntu 镜像在构建时执行 `ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> /etc/ssh/ssh_known_hosts`。而 `UserKnownHostsFile` **不会**关掉 `GlobalKnownHostsFile`（默认 `/etc/ssh/ssh_known_hosts`），所以这次 curl 拿到的内容在 runner 上本来就是冗余的（实测确认语义）。
- **`actions/checkout` 根本不做这次网络调用**：它把 github.com 的 `ssh-rsa` 公钥**硬编码在源码里**，用 `ssh-key` 时零外部依赖。业界首选做法就是 `actions/checkout` + `ssh-key` + `repository`，而不是手搓 `git clone` + known_hosts。
- 官方**有**静态指纹页，三行 known_hosts 条目可以直接写死；实测与 `/meta` 现场返回**逐字节一致**。2023-03-24 的 RSA 轮换，GitHub 是通过博客 + 更新 `actions/checkout` 全部 tag 来通知的 —— 写死的代价是轮换日要改仓库（GitHub 自己那天就改了源码并当天发了 v3.5.0 / v2.7.0）。

**Q2 — `verified` 分支这条已经是当前约束下最省的，不建议换。**

- `workflow_run` **不能跨仓**：官方语法里只有 `workflows`（按名字）、`types`、`branches`，没有任何仓库选择器。
- `repository_dispatch` 跨仓**成立**，但需要一枚 `repo` scope 的 classic PAT 长期躺在私有仓 secret 里，而且它只是把「公开仓去拉」换成「私有仓来推」，**不修复现在任何一个故障**。
- submodule **成立且更「标准」**（指针可复现），代价是每次 overlay 前移都要在公开仓做一次 bump 提交，把私有变更的节奏和 sha 写进公开历史，并且与现在「公开树完全不感知 overlay 版本」的设计（单入口 + 运行时契约校验）相反。
- 私有 npm 包（GitHub Packages）**最重**：只支持 classic PAT 认证，`.npmrc` 要提交进公开仓，且 overlay 现在是 pnpm workspace member，换成 registry 包等于重做安装模型。
- **需要纠正一个前提**：`deploy.yml:23` 已经把 `git@github.com:Muluk-m/ai-image-playground-private.git` 明文写在**公开追踪的文件**里（实测 `git ls-files` 确认该文件被追踪，`origin` 是公开仓）。「MIT 公开仓不能暴露私有仓地址」这条约束**事实上已经不成立**，所以它不应再作为否决上面任何方案的理由 —— 否决它们的是成本，不是保密。

**Q3 — 除那两处 `/meta` 外，deploy.yml 还有 4 类同型单点**，清单见第四节。值得注意的是同一个 workflow 里 health 轮询（`:197-207`）和 `pages-release.sh:148-165` 都写了 deadline + 重试，说明这个仓库的标准本来是对的，只有 `/meta` 这一处没按它写。

---

## 一、先钉住仓库现状

全部是本地检出 `/Users/qiqian/Projects/Self/aip-agent-confirm` 的实测事实。

| 事实 | 证据 |
| --- | --- |
| `origin` 是公开仓，`deploy.yml` / `deploy-test.yml` 都被 git 追踪 | `git remote -v` → `git@github.com-nain:Muluk-m/ai-image-playground.git`；`git ls-files --error-unmatch` 两个文件都命中 |
| 私有 overlay 仓地址明文写在公开仓 | `deploy.yml:23` `PRIVATE_OVERLAY_REPO: git@github.com:Muluk-m/ai-image-playground-private.git` |
| overlay 被 clone 进 `private/`，该目录被 ignore | `.gitignore:16-17`（注释：`The public tree must work when it is absent.`） |
| 仓库里**没有** `.gitmodules` | `git ls-files .gitmodules` 空 |
| 出事的那两处调用完全相同 | `deploy.yml:106`、`deploy.yml:226`；`deploy-test.yml:103` 是第三份同样的拷贝 |
| `shell: bash` 全局默认 = `-eo pipefail`，所以 `curl -f` 一失败整个 step 立即失败 | `deploy.yml:17-21`（注释自己写了这一点） |
| backend job 取 `verified` 分支，pages job 取 backend 输出的具体 sha | `deploy.yml:108`（`--branch verified`）、`:230`（`checkout --detach "$PRIVATE_SHA"`） |

出事的 step 全文（`deploy.yml:99-110`）：

```yaml
      - name: Check out the private overlay at its verified HEAD
        id: overlay
        env:
          PRIVATE_OVERLAY_SSH_KEY: ${{ secrets.PRIVATE_OVERLAY_SSH_KEY }}
        run: |
          umask 077
          printf '%s\n' "$PRIVATE_OVERLAY_SSH_KEY" > "$RUNNER_TEMP/overlay-key"
          curl -fsSL https://api.github.com/meta | jq -r '.ssh_keys[] | "github.com " + .' > "$RUNNER_TEMP/github-known-hosts"
          GIT_SSH_COMMAND="ssh -i $RUNNER_TEMP/overlay-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$RUNNER_TEMP/github-known-hosts" \
            git clone --quiet --branch verified "$PRIVATE_OVERLAY_REPO" private
          rm -f "$RUNNER_TEMP/overlay-key"
          echo "sha=$(git -C private rev-parse HEAD)" >> "$GITHUB_OUTPUT"
```

---

## 二、Q1：`/meta` 这次调用

### 2.1 限额：匿名 60/h（按 IP），带 token 5,000/h

**实测（2026-09-22，本机）**：

```
=== anonymous ===
x-ratelimit-limit: 60
x-ratelimit-remaining: 57
x-ratelimit-used: 3
x-ratelimit-resource: core

=== with token (Bearer, X-GitHub-Api-Version: 2022-11-28) ===
x-ratelimit-limit: 5000
x-ratelimit-remaining: 4604
x-ratelimit-used: 396
x-ratelimit-resource: core
```

文档口径完全吻合：

- 「The primary rate limit for unauthenticated requests is **60 requests per hour**.」且「Unauthenticated requests are associated with the **originating IP address**, not with the user or application that made the request.」
  <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28#primary-rate-limit-for-unauthenticated-users>
- PAT / OAuth / GitHub App 用户令牌：**5,000 requests per hour**（同页 `#primary-rate-limit-for-authenticated-users`）。
- **`GITHUB_TOKEN` 是 1,000 requests per hour per repository**（同页 `#primary-rate-limit-for-github_token-in-github-actions`）。注意它比 PAT 低，但比匿名高 16 倍。
- 超限行为：「If you exceed your primary rate limit, you will receive a **`403` or `429`** response, and the `x-ratelimit-remaining` header will be `0`.」（同页 `#exceeding-the-rate-limit`）

**为什么会 403**：`/meta` 端点本身文档只列 `200` 和 `304` 两种状态码（<https://docs.github.com/en/rest/meta/meta?apiVersion=2022-11-28#get-github-meta-information>），端点级不会给 403。所以 403 只能来自限流层。GitHub-hosted runner 的出口 IP 是共享的（`/meta` 自己就返回 `actions` 网段），因此匿名请求落进的是一个**与他人共享的 60 次/小时桶** —— 这一步是[推论]，前提（匿名按 IP 计、超限回 403）均有文档。这也解释了为什么它平时没事、偶尔整条挂：桶不是我们自己耗完的，加重试也只是把失败推迟到下一小时。

**能不能带 `GITHUB_TOKEN` 调 `/meta`？** `/meta` 不需要任何 permission，`Authorization: Bearer` 对它有效（实测用 PAT 验证过）；`GITHUB_TOKEN` 属于 GitHub App installation token，文档没有把 `/meta` 列为例外。但**未验证**：没有在真实 Actions 运行里用 `GITHUB_TOKEN` 打过 `/meta`，也没有实测到 `x-ratelimit-limit: 1000`。不过这条路不值得走 —— 见 2.2 / 2.3，这次调用可以直接删。

### 2.2 runner 里**已经**有的东西：`/etc/ssh/ssh_known_hosts`

`actions/runner-images` 的 ubuntu 镜像构建脚本最后两行：

```bash
# Add well-known SSH host keys to known_hosts
ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> /etc/ssh/ssh_known_hosts
ssh-keyscan -t rsa ssh.dev.azure.com >> /etc/ssh/ssh_known_hosts
```

<https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-git.sh>

**实测确认它在当前投产的镜像里**：拉 `ubuntu24/20260831.293`、`ubuntu24/20260907.300`、`ubuntu24/20260920.314`（最后一个发布于两天前）三个 release tag 的同一文件，三个都含这两行。`ubuntu-slim` 与 windows 镜像也有同样的处理（`images/ubuntu-slim/scripts/build/install-git.sh`、`images/windows/scripts/build/Install-Git.ps1`、macOS 是 `images/macos/scripts/build/configure-ssh.sh`）。

**关键语义：`UserKnownHostsFile` 不会覆盖 `GlobalKnownHostsFile`。** 两者是两套独立数据库：

> `GlobalKnownHostsFile` — Specifies one or more files to use for the global host key database … The default is `/etc/ssh/ssh_known_hosts`, `/etc/ssh/ssh_known_hosts2`.
> <https://man.openbsd.org/ssh_config#GlobalKnownHostsFile>

**实测（本机 OpenSSH_10.3p1）**：

| 场景 | 结果 |
| --- | --- |
| `UserKnownHostsFile` 指向**空文件** + `GlobalKnownHostsFile` 有 github.com，`StrictHostKeyChecking=yes` | 通过主机校验，只在认证环节失败（`git@github.com: Permission denied (publickey).`） |
| user 与 global **都空** | `No ED25519 host key is known for github.com and you have requested strict checking.` / `Host key verification failed.` |

也就是说：在 ubuntu runner 上，把 `curl` 那行和 `-o UserKnownHostsFile=...` 一起删掉，`StrictHostKeyChecking=yes` 仍然生效，host key 从镜像预置的全局库来。

**代价要说清**：这两行是镜像**构建脚本**的实现细节，`ssh-keyscan` 抓的是构建当时的快照；并且它**没有出现在对外发布的镜像说明里**（实测：`ssh_known_hosts` 在 runner-images 仓库里只出现在 3 个 build 脚本中，`images/ubuntu/Ubuntu2404-Readme.md` 里 0 次命中 `known_hosts` / `keyscan`）。所以这是一个**可依赖但无文档承诺**的事实。

### 2.3 官方静态指纹页 + 2023 轮换是怎么通知的

官方文档页直接给出可粘贴进 `known_hosts` 的三行：

> You can add the following ssh key entries to your `~/.ssh/known_hosts` file to avoid manually verifying GitHub hosts:
> `github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl`
> `github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=`
> `github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+…wsjk=`（RSA，完整值见原页）

<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>

**实测**：把该页三行与现场 `GET /meta` 的 `ssh_keys` 排序后对比 → **完全一致**（3 条，逐字节相同）；`/meta` 的 `ssh_key_fingerprints` 也与页面上的 `SHA256:` 指纹一致（`SHA256_RSA = uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s` 等）。也就是说静态页与动态端点是同一份数据，写死不会更不准。

**2023-03-24 的 RSA 轮换（官方博客，一手）**：

- 「At approximately 05:00 UTC on March 24 … we replaced our RSA SSH host key … Only GitHub.com's RSA SSH key was replaced. No change is required for ECDSA or Ed25519 users.」
- 官方给个人机器的修复恰好就是我们 workflow 里那条命令：`curl -L https://api.github.com/meta | jq -r '.ssh_keys | .[]' | sed -e 's/^/github.com /' >> ~/.ssh/known_hosts`。**这条命令的出处是「个人开发机一次性修复」指引，不是 CI 指引** —— 把它搬进每次部署都跑的 job，就把一次性操作变成了每次部署的外部依赖。
- 对 Actions 用户的说明：「GitHub Actions users may see failed workflow runs if they are using `actions/checkout` with the `ssh-key` option. We are updating the `actions/checkout` action in **all our supported tags**, including @v2, @v3, and @main. **If you pin the action to a commit SHA and use the `ssh-key` option, you'll need to update your workflow.**」

<https://github.blog/news-insights/company-news/we-updated-our-rsa-ssh-host-key/>（2023-03-24，GitHub CSO 署名）

**轮换的维护成本可以量化**（实测查 GitHub API）：`actions/checkout` 在 **2023-03-24** 有一个提交 `8f4b7f84` **"Add new public key for known_hosts (#1237)"**，diff 就是把 `src/git-auth-helper.ts` 里硬编码的那一行从旧 RSA 公钥（`AAAAB3NzaC1yc2EAAAABIwAAAQEA…`）换成新的（`AAAAB3NzaC1yc2EAAAADAQABAAAB…`）；**同一天**发布了 `v3.5.0` 与 `v2.7.0`。所以「写死 host key」的真实代价是：轮换日需要一次代码改动 + 一次发布 —— GitHub 自己就是这么付的。

### 2.4 `actions/checkout` 自己怎么处理 known_hosts（读源码）

`src/git-auth-helper.ts` 的 `configureSsh()`（仅在 `ssh-key` 非空时执行）：

1. 把 key 写进 `$RUNNER_TEMP/<uuid>`，`{mode: 0o600}`；
2. 读 `~/.ssh/known_hosts`（不存在就跳过），再拼上 `ssh-known-hosts` 输入的内容；
3. **无条件追加一段硬编码的 github.com host key**：

```ts
    knownHosts += `# Begin implicitly added github.com\ngithub.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+…wsjk=\n# End implicitly added github.com\n`
```

4. 写 `$RUNNER_TEMP/<uuid>_known_hosts`，然后拼出 `GIT_SSH_COMMAND`：
   `ssh -i "$RUNNER_TEMP/<key>"`，若 `ssh-strict`（**默认 true**）则追加 `-o StrictHostKeyChecking=yes -o CheckHostIP=no`，最后 `-o "UserKnownHostsFile=$RUNNER_TEMP/<uuid>_known_hosts"`。

<https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts>（`configureSsh`；本次读的是 `main`）

要点：

- **零网络调用**。host key 来自源码常量，`/meta` 一次都不打。
- 它只带 **RSA 一种**算法。实测这足够：known_hosts 里只放那一行 ssh-rsa，配上 checkout 用的完全相同的选项（`StrictHostKeyChecking=yes -o CheckHostIP=no`），连接通过主机校验，只在认证环节失败。（OpenSSH 会把主机密钥算法偏好重排到 known_hosts 里已有的算法上。）
- `ssh-known-hosts` 输入是**追加**语义，官方描述明确：「Known hosts **in addition to** the user and global host key database … **The public key for github.com is always implicitly added.**」
  <https://github.com/actions/checkout/blob/main/action.yml>（`ssh-known-hosts` / `ssh-strict` / `ssh-user` 三个输入）
- 清理：`persist-credentials: false` 时，`git-source-provider.ts` 在同一步的 `finally` 里调 `authHelper.removeAuth()`（`if (!settings.persistCredentials) { … await authHelper.removeAuth() }`），加上 post-job 的清理。语义与现在手写的 `rm -f "$RUNNER_TEMP/overlay-key"` 等价。
  <https://github.com/actions/checkout/blob/main/src/git-source-provider.ts>

### 2.5 业界首选：`actions/checkout` + `ssh-key`（含参数确认）

README 的「Checkout multiple repos (private)」场景给的是 `token: ${{ secrets.GH_PAT }}`，并注明「`${{ github.token }}` is scoped to the current repository, so if you want to checkout a different repository that is private you will need to provide your own PAT」。
<https://github.com/actions/checkout/blob/main/README.md#checkout-multiple-repos-private>

三种凭证形态与本仓库的匹配度：

| 凭证 | 机制 | 对本仓库 |
| --- | --- | --- |
| **Deploy key（SSH）** | `ssh-key` 输入 → `getFetchUrl()` 在 `sshKey` 存在时生成 `git@github.com:<owner>/<repo>.git` | ✅ **当前已在用**（`secrets.PRIVATE_OVERLAY_SSH_KEY`），权限只覆盖那一个仓库，最小 |
| PAT | `token` 输入 | ❌ 一枚 PAT 覆盖账号下全部仓库，权限比 deploy key 大 |
| GitHub App installation token | 先换 token 再传 `token` | ❌ 要额外建 App + 存 app id / private key，收益为零 |

`getFetchUrl()` 源码确认 SSH URL 的构造：

```ts
  if (settings.sshKey) {
    const user = settings.sshUser.length > 0 ? settings.sshUser : 'git'
    return `${user}@${serviceUrl.hostname}:${encodedOwner}/${encodedName}.git`
  }
```

<https://github.com/actions/checkout/blob/main/src/url-helper.ts>

两处调用需要的 ref 形态 checkout 都支持：

- `ref: verified`（分支名）→ `getCheckoutInfo()` 走「Unqualified ref」分支，`branchExists(true, 'origin/verified')` 命中即用。<https://github.com/actions/checkout/blob/main/src/ref-helper.ts>
- `ref: <40 位 sha>`（pages job 需要）→ `input-helper.ts` 里 `asciiTrimmedRef.match(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/)` 命中时把它当 `commit` 直接 fetch，不要求它在某个分支上。<https://github.com/actions/checkout/blob/main/src/input-helper.ts>
- 输出 `commit`（`outputs.commit`: "The commit SHA that was checked out"，`action.yml`）可以直接替掉现在手写的 `git -C private rev-parse HEAD`。

---

## 三、Q2：两仓耦合的替代方案

### 3.1 `workflow_run` 跨仓 —— **不成立**

官方语法参考里 `workflow_run` 只有三个可配项：`workflows`（**按工作流名字**）、`types`、`branches` / `branches-ignore`。**没有任何仓库选择器**。
<https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_runbranchesbranches-ignore>

事件文档对 `workflow_run` 的其他硬约束：

- 「This event will only trigger a workflow run if the workflow file exists on the **default branch**.」
- 「You **can't use `workflow_run` to chain together more than three levels** of workflows.」
- 「The workflow started by the `workflow_run` event is able to access secrets and write tokens, even if the previous workflow was not.」（这正是本仓库 `deploy.yml:6-9` 在用的能力，同仓内）
  <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run>

该页对绝大多数事件的描述统一是「in **the workflow's repository**」（`create` / `delete` / `deployment` / `issues` / `label` / `public` / `pull_request` / `watch` 等）。结合语法层没有跨仓入口，结论是 `workflow_run` 只能消费**同仓**的工作流完成事件。（「跨仓不支持」这句在文档里没有一句原话直接否定，属[推论]，但两条前提都是原文。）

### 3.2 `repository_dispatch` / `workflow_dispatch` 跨仓 —— **成立，但不解决当前问题**

- `POST /repos/{owner}/{repo}/dispatches`，「OAuth app tokens and personal access tokens (classic) need the **`repo` scope**」。
  <https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#create-a-repository-dispatch-event>
- 触发规则：「When you use the repository's `GITHUB_TOKEN` … events triggered by the `GITHUB_TOKEN` will **not** create a new workflow run, with the following exceptions: **`workflow_dispatch` and `repository_dispatch` events always create workflow runs**.」但 `GITHUB_TOKEN` 只对**自己仓库**有权，所以跨仓必须换成 PAT 或 GitHub App installation token：「If you do want to trigger a workflow from within a workflow run, you can use a GitHub App installation access token or a personal access token instead of `GITHUB_TOKEN`」。
  <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow>
- `repository_dispatch` 的 `client_payload` 最多 10 个顶层属性、总大小 < 64KB，`event_type` ≤ 100 字符；且「only trigger … if the workflow file exists on the default branch」。
  <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch>

**评价**：技术上可以把现在的「公开仓部署时去拉 `verified`」改成「overlay CI 全绿后 dispatch 公开仓，payload 里带上 overlay sha」。但：（a）需要在私有仓存一枚 `repo` scope 的 classic PAT（权限比现在的 deploy key 大得多，且会覆盖公开仓的写权限）；（b）它把「用哪个 overlay 提交」从消费侧的拉取时刻，变成生产侧的推送时刻 —— 一旦 dispatch 丢了就得手动补；（c）它**不修**任何现有故障（`/meta` 的 403 与耦合方式无关）。所以是「可行但没必要」。

### 3.3 私有仓作为 git submodule —— **成立且更「标准」，但与现有设计相反**

支持情况（都有一手出处）：

- `.gitmodules` 是**工作树顶层的被追踪文本文件**，其中 `submodule.<name>.url` 「Defines a URL from which the submodule repository can be cloned」。
  <https://git-scm.com/docs/gitmodules>
- `actions/checkout` 支持 `submodules: true|recursive`，且**有 `ssh-key` 时会沿用 SSH URL**：「When the `ssh-key` input is **not** provided, SSH URLs beginning with `git@github.com:` are converted to HTTPS.」
  <https://github.com/actions/checkout/blob/main/action.yml>（`submodules` 输入）
- 源码侧对应 `configureSubmoduleAuth()`：有 `sshKey` 时对每个 submodule 执行 `git config --local core.sshCommand '<同一条 ssh 命令>'`；没有时才写 `url.…insteadOf` 把 SSH 改 HTTPS。
  <https://github.com/actions/checkout/blob/main/src/git-auth-helper.ts>

**代价**（这才是否决理由，不是保密）：

1. submodule 指针是**公开仓里的一个 git 对象**。overlay 每前移一次，公开仓就要 bump 一次提交 —— 而公开仓的 `push: main` 会触发 `Web checks`（`web.yml:4-5`），进而触发 `Deploy production`（`deploy.yml:6-9`）。等于把私有变更的节奏、次数、sha 全部写进公开历史，并且每次私有改动都会跑一整条生产部署。
2. 与现有设计方向相反：公开树现在**完全不感知** overlay 版本（`.gitignore:16-17` 的注释「The public tree must work when it is absent.」+ 单一入口运行时契约校验）。submodule 把版本绑定搬进公开树，`private/` 也不能再是 ignore 目录。
3. 并不能替代 `verified` 闸门 —— 除非 bump 时只允许指向 `verified` 指向过的提交，那就是在 submodule 之上再叠一层现在已有的机制。

### 3.4 overlay 发成私有 npm 包（GitHub Packages）—— **成立，最重**

- 认证：「**GitHub Packages only supports authentication using a personal access token (classic).**」，且在 Actions 里「`GITHUB_TOKEN` to publish packages associated with **the workflow repository**；A personal access token (classic) with at least **`read:packages`** scope to install packages associated with **other private repositories**」。
  <https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages>
- 消费侧必须把 `.npmrc` **提交进仓库**：「Add the *.npmrc* file to the repository where GitHub Packages can find your project」，内容形如 `@NAMESPACE:registry=https://npm.pkg.github.com`；依赖名还要写进 `package.json`（进而进 `pnpm-lock.yaml`）。
  （同页 `#installing-a-package`）
- 首次发布默认私有：「When you first publish a package, the default visibility is **private**.」（同页 `#publishing-a-package`）

**代价**：（a）多一枚长期 classic PAT（`read:packages`）；（b）命名空间与包名进公开仓的 `.npmrc` / `package.json` / lockfile；（c）**与现有安装模型冲突**：overlay 现在是 pnpm workspace member，公开 lockfile 里就带着 `private/apps/*` 的 importer（`Dockerfile:8-9` 的注释写明：「The public lockfile carries the private/apps/* importers, so pnpm fetches their dependencies only when the overlay manifests are present at install time」），`deploy.yml:234` 还要在 clone overlay **之后**再跑一次 `pnpm install --frozen-lockfile`。换成 registry 包等于重做这套安装模型；（d）每次 overlay 改动都要走 version bump + publish，比推一个 `verified` 指针重得多。

### 3.5 汇总

| 方案 | 跨仓可行 | 保密（注：该约束已不成立，见结论） | 新增长期凭证 | 与现有设计的冲突 | 值不值得换 |
| --- | --- | --- | --- | --- | --- |
| **现状：`verified` 分支 + 消费侧拉取** | ✅ | 地址已明文在 `deploy.yml:23` | 无（已有 deploy key） | 无 | — |
| `workflow_run` 跨仓 | ❌ 语法不支持 | — | — | — | 不可行 |
| `repository_dispatch` | ✅ | 同现状 | `repo` scope classic PAT | 低 | 不换（不修任何故障） |
| git submodule | ✅ | URL 进 `.gitmodules` | 无 | **高**（公开树要感知 overlay 版本、每次 bump 触发生产部署） | 不换 |
| GitHub Packages 私有包 | ✅ | 包名进公开 `.npmrc` | `read:packages` classic PAT | **高**（重做 workspace 安装模型） | 不换 |

---

## 四、Q3：`deploy.yml` 里同型的「匿名外部依赖 / 无重试」单点

通读 `deploy.yml`（239 行）的结果。**只列，不改。**

| # | 位置 | 性质 | 有无重试 |
| --- | --- | --- | --- |
| 1 | `:106`、`:226` | **匿名** `curl -fsSL https://api.github.com/meta`（本次故障源）。`shell: bash` 的 `-eo pipefail` 使其失败即终止 job | ❌ 无 `--retry`、无回退 |
| 1b | `deploy-test.yml:103` | 同一行的第三份拷贝（测试站发布链） | ❌ |
| 2 | `:48`、`:89`、`:164` `actions/checkout@v4`；`:111` `docker/login-action@v3`；`:210` `pnpm/action-setup@v4`；`:211` `actions/setup-node@v4`；`:215` `oven-sh/setup-bun@v2` | 5 个第三方 action 全部 pin 在**可变的 major tag** 上 —— 既是供应链单点也是可用性单点 | ❌ action 下载失败无重试 |
| 3 | `:216`、`:234` `pnpm install --frozen-lockfile`；`:211` setup-node 下 Node；`:215` setup-bun 下 Bun | npm registry / Node / Bun 发行源 | ❌ 无显式重试或镜像回退（各 action 内部是否重试**未验证**） |
| 4 | `:123` → `scripts/build-vps-release.sh:97,107` `docker buildx build` | 拉 Docker Hub 上的镜像：`Dockerfile:1` 的 `# syntax=docker/dockerfile:1.6`（BuildKit frontend，构建时从 registry 拉）、`Dockerfile:10,20,70` `oven/bun:1`（**浮动 tag**，非 digest）、`deploy/backup/Dockerfile:1` `postgres:17.6-alpine3.22`；镜像内还有 `apt-get update`（Debian 源） | ❌ |
| 5 | `:218`、`:236` → `scripts/pages-release.sh` → `scripts/pages-deploy.sh:102` `wrangler pages deploy` | Cloudflare API | ❌ 脚本层无重试（wrangler 自身是否内建重试**未验证**） |
| 6 | `:137-141` `tar \| ssh` 到 VPS | 单次，无重试。**但 known_hosts 来自 secret `VPS_SSH_KNOWN_HOSTS`（`:135`）而不是网络获取** —— 这正是 `/meta` 那两处该有的形态，同一个文件里已有正确范例 | ❌ 无重试（known_hosts ✅ 无外部依赖） |
| — | `:197-207` health 轮询（300s deadline + 10s 间隔 + `--max-time 10`）；`pages-release.sh:148-165` version.json 轮询同形 | **正面例子**：这个仓库对外部 HTTP 的既有标准是 deadline + 重试 | ✅ |

第 6 行和最后一行合起来说明：`/meta` 那两处不是「这个仓库不懂重试」，而是这一处**漏掉了仓库自己的标准**，而且旁边就摆着「known_hosts 走 secret」的正确做法。

---

## 五、建议

### 方案 A（推荐）：把两处手搓 clone 换成 `actions/checkout` + `ssh-key`

**改哪几行**（三处，形状相同）：

| 文件 | 行 | 动作 |
| --- | --- | --- |
| `.github/workflows/deploy.yml` | `99-110` | 整个 `Check out the private overlay at its verified HEAD` step 换成一个 `uses: actions/checkout@<commit-sha>`，`with:` = `repository: Muluk-m/ai-image-playground-private`、`ref: verified`、`ssh-key: ${{ secrets.PRIVATE_OVERLAY_SSH_KEY }}`、`path: private`、`persist-credentials: false`；下游 `steps.overlay.outputs.sha` 改读 checkout 的 `outputs.commit` |
| `.github/workflows/deploy.yml` | `219-232` | 同上，`ref: ${{ needs.backend.outputs.private_sha }}`；`[ -d private/pages-assets ]` 那两行（`:231-232`）保留为独立的校验 step |
| `.github/workflows/deploy.yml` | `23` | `PRIVATE_OVERLAY_REPO` 的值从 `git@github.com:Muluk-m/….git` 改成 `Muluk-m/ai-image-playground-private`（checkout 的 `repository` 要 `owner/repo` 形式） |
| `.github/workflows/deploy-test.yml` | `97-106` | 同 `deploy.yml:99-110`，`ref` 用 overlay 的 `main` |
| `.github/workflows/deploy.yml` | `237-239` | 清理 step 里的 `"$RUNNER_TEMP/overlay-key"` 可以去掉（checkout 自己清） |

**为什么**：

1. **删掉了故障源本身**，而不是给它加重试。checkout 的 host key 是源码常量，这一步再也不打任何网络接口拿 known_hosts（`src/git-auth-helper.ts`）。
2. 安全等价甚至更好：`ssh-strict` 默认 true → `StrictHostKeyChecking=yes -o CheckHostIP=no`；key 以 `0o600` 写入 `$RUNNER_TEMP`；`persist-credentials: false` 时步骤结束即 `removeAuth()`。与现在手写的 `umask 077` + `rm -f` 同级。
3. 少 30 行 shell、少一处 `jq` 依赖、少一次 `git rev-parse`（改用 `outputs.commit`）。
4. 默认 `fetch-depth: 1` 是浅克隆，比现在的完整 `git clone` 快。
5. 凭证形态不变 —— 继续用现有的 deploy key，不引入 PAT。
6. 下游脚本不受影响：`scripts/build-vps-release.sh:26-27` 会对 `private/` 跑 `git status --porcelain --untracked-files=no` 和 `git rev-parse HEAD`，checkout 留下的仍是一个真 git 仓库、且默认 `clean: true` 保证工作树干净，浅克隆与 detached HEAD 都不影响这两条命令。

**代价（要接受的）**：

- 把「host key 的正确性」从 GitHub 的运行时接口，换成了 `actions/checkout` 某个 commit 里的常量。2023 那次轮换 GitHub 当天更新了所有 tag，**但 pin 到 commit SHA 的用户需要自己 bump**（官方博客原文）。选 pin SHA 就要接受轮换日手动 bump；选 pin `@v4` 就要接受可变引用。**建议 pin SHA 并在 `docs/deploy/image-release.md` 的 runbook 里记一句「github.com host key 轮换时需要 bump checkout 的 pin」** —— 这是唯一的新增维护负担，而且它是有官方博客广播的、几年一次的事件，比「每次部署都赌一个共享 IP 的 60 次配额」量级低得多。
- `actions/checkout` 只带 RSA 一种 host key 算法（实测足够）。如果哪天 GitHub 停用 RSA host key（未验证有此计划），需要靠 `ssh-known-hosts` 输入补 ed25519 —— 而那一行可以直接抄官方静态指纹页。

### 方案 B（最小改动，若不想引入 action）

只删 `deploy.yml:106` / `:226` 的 `curl` 那行，并把 `:107` / `:227` 里的 `-o UserKnownHostsFile=$RUNNER_TEMP/github-known-hosts` 一起删掉，靠镜像预置的 `/etc/ssh/ssh_known_hosts`（本机已实测 `StrictHostKeyChecking=yes` 在这种配置下正常校验）。

代价：依赖一个**没有对外文档承诺**的镜像实现细节（实测它在 `ubuntu24/20260920.314` 等三个投产 tag 里都存在，但不在镜像 README 里）。方案 A 的依赖（action 源码常量）是可 pin 可审计的，方案 B 的依赖不可 pin。

### 方案 C（兜底，不推荐作为首选）

把官方静态指纹页的三行存成仓库里一个文件（例如 `deploy/github-known-hosts`），`-o UserKnownHostsFile=` 指向它。代价与 checkout 硬编码同构（轮换日改仓库），但至少与部署时的网络完全解耦，且三行都在、不只 RSA。适合在不愿依赖第三方 action 又不愿依赖镜像细节时选。

### 不建议动的部分

- **两仓耦合方式保持现状**（`verified` 分支 + 消费侧拉取）。三个替代方案里两个（submodule / npm 包）与「公开树不感知 overlay」的现有设计正面冲突，一个（`repository_dispatch`）要换一枚权限更大的长期 PAT 却不修任何故障。
- 「不能暴露私有仓地址」这条约束请从决策依据里划掉：`deploy.yml:23` 已经明文写着，它是公开追踪文件。后续讨论应该只比成本。

### 可以顺手排的（Q3 第 2 项，与本次故障无关）

把 5 个第三方 action 从可变 major tag 改 pin 到 commit SHA。它和方案 A 的「pin SHA」是同一件事，一次做完比分两次好。这是独立改动，本次不建议混进同一个 PR。
