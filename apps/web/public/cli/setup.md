# Muvloom agent setup

Install Muvloom CLI, install the official skill for this host, connect the user's
account, and report when ready. Detect the operating system and the current agent
host automatically (WorkBuddy, 豆包工作, Claude Code, Codex, Cursor, or another
host) — do not ask the user which host or OS they are using, and keep the number
of shell tool calls minimal by combining setup steps where possible. Keep the
conversation in the user's language. Do not generate images during setup, and do
not spend credits unless the user asks.

When this guide points to another file in the same folder (for example
`workbuddy.md`, `doubao.md`, `install.sh`, `install.ps1`, or a skill zip), fetch
it from the same address as this page with its file name replaced, keeping this
page's `?v=` query. That value changes whenever the guides or installers change,
so a cached older copy is never used.

## Fast path: install CLI + Skill in one shell call

Combine installing/updating the CLI and installing the host skill into a single
shell command whenever this host can run shell commands, so setup finishes in
at most two steps (1. install/update CLI + skill, 2. authorize account; on CLI 0.2.7+,
`muvloom setup --origin <this-guide-origin> --timeout 15` combines active host skill install,
browser authorization, `capabilities`, and the zero-cost `images validate` smoke check):

- **WorkBuddy**: run `muvloom skill install --host workbuddy` right after installing/updating the CLI (writes `~/.workbuddy/skills/muvloom/` or `%USERPROFILE%\.workbuddy\skills\muvloom\` and enables automatic skill hot-updates). Confirm the skill is enabled and `/muv` finds 幕芽 in a new task (if not visible yet, ask the user to fully quit and reopen WorkBuddy, then retry `/muv`). Only fetch [the WorkBuddy guide](workbuddy.md) if you need detailed troubleshooting or the ZIP fallback (which also includes the zero-dependency `scripts/muvloom` / `scripts\muvloom.cmd` launcher).
- **Claude Code**: run `muvloom skill install --host claude-code` (or `muvloom setup --origin <this-guide-origin>` on CLI 0.2.7+) right after installing/updating the CLI.
- **Codex**: run `muvloom skill install --host codex` (or `muvloom setup --origin <this-guide-origin>` on CLI 0.2.7+) right after installing/updating the CLI.
- **豆包工作**: follow [the Doubao Work guide](doubao.md) (keeping `?v=`) to import `muvloom-doubao.zip`.
- **Other hosts**: download `muvloom-skill.zip?v=<this-page-v>` (or run `muvloom skill install --host generic --output <dir>`) and install `muvloom/` into the host's skill directory or upload it via the host UI (on CLI 0.2.7+, `muvloom setup --origin <this-guide-origin>` auto-detects Cursor, Windsurf, Cline, and OpenClaw as well).

## 1. Install or update to the latest Muvloom CLI

Run the verified installer below to install or upgrade `muvloom` to the latest
stable release. If the latest release is already installed, the installer skips
the download automatically; if a newer copy is already installed, it refuses to
downgrade. Replacing an older copy in place keeps the user's sign-in.

Also check common install paths if `muvloom` is not yet on PATH
(`~/.local/bin/muvloom`, `/usr/local/bin/muvloom`, `/opt/homebrew/bin/muvloom`
on macOS / Linux; `%LOCALAPPDATA%\Programs\muvloom\muvloom.exe` on Windows).

Do not pipe a downloaded script into `sh` or `iex`, and do not pin
`MUVLOOM_VERSION` to an older release. Download the script to a temporary file,
verify the SHA-256 published here, then execute. Fetch `install.sh` or
`install.ps1` from the same folder as this guide (same origin and `?v=`).

### macOS / Linux

SHA-256 of `install.sh`:
`2d814705e65cc9e2dc25046b6e3eb9d106ee5c1632d8e2189fc5c13f02a30161`

```sh
tmp="$(mktemp)"
curl -fsSL "<this-guide-origin>/cli/install.sh?v=<this-page-v>" -o "$tmp"
actual="$(command -v sha256sum >/dev/null && sha256sum "$tmp" | awk '{print $1}' || shasum -a 256 "$tmp" | awk '{print $1}')"
[ "$actual" = "2d814705e65cc9e2dc25046b6e3eb9d106ee5c1632d8e2189fc5c13f02a30161" ] || { echo "checksum mismatch"; exit 1; }
sh "$tmp"
export PATH="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
```

Replace `<this-guide-origin>` and `<this-page-v>` with the origin and `v` query
of this page. The installer appends the install directory to the user's shell
profile when it is missing (it prints the exact file it changed). Still run the
`export PATH=...` line in this session: each agent command may be a new shell,
and a profile change is only picked up by later sessions. Do not write
`MUVLOOM_API_URL` into a profile.

### Windows (PowerShell)

SHA-256 of `install.ps1`:
`d3d160e3781b10af36f2fda5c9763b902c42b44e7e2762d19589a7441645a646`

```powershell
$script = Join-Path $env:TEMP "muvloom-install.ps1"
Invoke-WebRequest "<this-guide-origin>/cli/install.ps1?v=<this-page-v>" -UseBasicParsing -TimeoutSec 20 -OutFile $script
if ((Get-FileHash $script -Algorithm SHA256).Hash.ToLower() -ne "d3d160e3781b10af36f2fda5c9763b902c42b44e7e2762d19589a7441645a646") { throw "checksum mismatch" }
powershell -NoProfile -ExecutionPolicy Bypass -File $script; if ($LASTEXITCODE -ne 0) { throw "muvloom installer failed with exit code $LASTEXITCODE" }
$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")
```

The PATH update must also apply to subsequent commands in this agent session. If
the direct release download fails, the installer automatically tries the official
GitHub Release API and verifies the same SHA-256 checksums. If the installer
still fails, report its error.

## 2. Select the service

Use the origin of the setup URL supplied by the user's request:

| Setup origin | MUVLOOM_API_URL |
| --- | --- |
| https://muvloom.online | https://api.muvloom.online |
| https://image.nainma.online | https://api.muvloom.online |
| https://image-playground.qiliangjia.one | https://image-api.qiliangjia.one |
| https://test.muvloom.online | https://test-api.muvloom.online |

Set `MUVLOOM_API_URL` before the first `muvloom auth status` in this setup,
including the production service (`https://api.muvloom.online`).
On macOS / Linux: `export MUVLOOM_API_URL="<matching URL>"`. In PowerShell:
`$env:MUVLOOM_API_URL = "<matching URL>"`. Naming the service explicitly lets the
CLI notice when this machine is signed in to a different one (`service_mismatch`)
instead of quietly reusing that connection: the user may have a test or
enterprise connection and opened the production page, or the other way round.

Keep the variable set through that first `auth status` and, if needed, the
following `auth login`. Once the target service reports `state: ready`, unset
`MUVLOOM_API_URL` and do not write it into a profile or later commands.
`auth status` then reports `api_url_source: connection` and works without the
variable. If the origin is not listed, ask which service to connect to instead
of guessing.

## 3. Install host instructions

For Claude Code, run:

```sh
muvloom skill install --host claude-code
```

For Codex, run:

```sh
muvloom skill install --host codex
```

For WorkBuddy, run:

```sh
muvloom skill install --host workbuddy
```

(This installs into `~/.workbuddy/skills/muvloom/` and enables automatic skill
hot-updates. If detailed troubleshooting or the ZIP fallback is needed, see
[the WorkBuddy guide](workbuddy.md).) Confirm that a new task's `/muv` finds 幕芽
before reporting setup complete.

For 豆包工作, follow [the Doubao Work guide](doubao.md) to install the official
skill from the conversation and connect the account. Confirm that a new work
task's `/muv` (or a `/` / `@` search for muv, 幕芽 or muvloom) finds 幕芽 before
reporting setup complete. Do not write into unverified directories such as
`~/.doubao/skills`.

For other hosts, download the official skill package `muvloom-skill.zip` from
the same folder as this guide (keep this page's `?v=`), or run
`muvloom skill install --host generic --output <dir>` to export a local
`muvloom/` folder. If the host has a skill directory, install `muvloom/` there
(target `.../skills/muvloom/SKILL.md`, with no extra nested folder). If the host
installs skills through its UI, upload that zip or the `muvloom/` folder with
the host's add/upload-skill action. After setup, tell the user to type `/muv`
(or the host's equivalent slash) to find 幕芽.

`muvloom skill install --host` accepts `claude-code`, `codex`, `workbuddy`, and
`generic` (plus `auto`, `cursor`, `windsurf`, `cline`, and `openclaw` on CLI 0.2.7+).
Do not invent `--host doubao`, and do not write into an unverified host configuration
directory as the default method.

## 4. Connect the account

Set `MUVLOOM_API_URL` as in step 2, then run `muvloom auth status` first (see
step 5 for retries if it is `unreachable`). If it reports `state: ready` for
the service named by this page, keep the existing connection, unset
`MUVLOOM_API_URL`, and proceed to step 5. If it is
`service_mismatch`, `MUVLOOM_API_URL` points at a different service than the one
this machine is signed in to (`connection_api_url`): do not log in again on your
own. Unset the variable to use the existing connection, or run
`muvloom auth login --switch-service` only if the user wants the service named
by this page.

`state: unreachable` is a transient service or network problem, not a missing
login. Do not start a new `auth login` and do not open another approval page.
Retry as in step 5; if it is still unreachable, tell the user to retry later
(稍后重试) and leave an existing connection untouched.

Authorization must use the **system default browser**. The user may already be
signed into muvloom there. Never pick Chrome or any other specific browser,
never run `Start-Process` (or equivalent) on a browser executable, never use
desktop control / 操作电脑 / 附属浏览器 to hunt for a browser, and never
request elevated privileges to open a URL.

Choose the login path that this host actually supports:

### A. The host cannot open or control the user's browser (default for cloud / remote / 豆包工作 cloud hosts)

This is the recommended path whenever you cannot pop a browser on the user's
computer (including a cloud execution environment). "Run `auth login` in the
foreground with the longest timeout and do not end the turn" is brittle when
the host kills the command on timeout, so do not rely on that here.

1. In one reply, tell the user you will give them an approval link to open in
   their **system default browser**, and that you will wait after they approve.
2. Set `MUVLOOM_NO_BROWSER=1` and run `muvloom auth login --no-wait` (keep
   `MUVLOOM_API_URL` set as in step 2). Paste both
   `verification_uri_complete` and `user_code` into the chat, clearly, and ask
   the user to open that link in their default browser, sign in, and approve.
3. Then wait with `muvloom auth login --timeout N` (use a short, host-safe N
   such as 15–30 seconds, and repeat while the user is still approving). It
   resumes the same login and does not open a new page. Stop on `AUTH_DENIED`;
   start over only on `AUTH_EXPIRED` (the code lasts 20 minutes).
4. After `state: ready`, unset `MUVLOOM_API_URL`.

### B. A local browser can be opened (local WorkBuddy, Claude Code, Codex, or a local desktop agent)

1. In one reply, tell the user an approval page is opening in their **system
   default browser** and that they only need to sign in and approve: you will
   continue on your own, so they do not need to reply. Do not end your turn.
2. Run `muvloom --json auth login --timeout 15` (or `muvloom auth login`) in the
   foreground and let the CLI open the default browser itself. It returns
   `state: ready` as soon as the user approves.
3. `AUTH_PENDING`, or a command the host cut off, means the user has not
   approved yet: on the first `AUTH_PENDING`, immediately share
   `verification_uri_complete` in chat in case the browser did not pop to front,
   then run `muvloom auth login --timeout 15` (or `muvloom auth login`) again.
   It resumes the same login and does not open another page. Stop on
   `AUTH_DENIED`; start over only on `AUTH_EXPIRED`.
4. If the CLI cannot open a browser, print `verification_uri_complete` (and
   `user_code`) clearly and ask the user to open that link in their default
   browser, then continue waiting as in path A. Do not switch browsers.
5. After `state: ready`, unset `MUVLOOM_API_URL`.

If the user declines (`AUTH_DENIED`), stop. If the code expires
(`AUTH_EXPIRED`), start a new login. Do not ask for passwords, browser cookies,
or tokens, and do not print stored credentials. If the host interrupts login
for a permission approval or replays the command, run `muvloom auth status`
before starting another login. A `ready` state means the connection succeeded.
Do not describe an invalid or already-used code as expired, or repeatedly open
new authorization pages after the user has approved. Never disable the host's
file or credential protection.

## 5. Confirm readiness

Read-only checks can flake (`TEMPORARILY_UNAVAILABLE`, exit 6, or
`auth status` → `state: unreachable`). That is a transient service or network
error, not a misconfiguration and not a reason to log in again.

Retry `muvloom auth status` and `muvloom capabilities` up to three attempts:
wait 5 seconds after the first failure, then 15 seconds after the second.
Distinguish transient errors (`TEMPORARILY_UNAVAILABLE`, `NETWORK_ERROR`,
`RATE_LIMITED`, `unreachable`, exit 6) from real misconfig (`unauthenticated`,
`outdated`, `service_mismatch`, `AUTH_DENIED`, `USAGE`). If the checks still
fail after three attempts, tell the user to retry later (稍后重试) and leave
an existing `ready` connection untouched.

Once `auth status` is `ready` and `capabilities` succeeds, run a zero-cost
smoke quote, for example `muvloom images validate --prompt "setup smoke"`.
This quotes without spending and is better proof than capabilities metadata
alone. Use the same retry policy if it fails transiently. Setup itself must
not run `images create` or otherwise spend credits unless the user asks.

Only report the connection as ready after auth status confirms it, capabilities
succeeds, and the validate quote succeeds. Briefly list this account's available
model labels from the capabilities response and mark `default_model`; use IDs
if labels are missing or ambiguous. Both IDs and labels are accepted (for
example `gpt-image-2.5-flare` and `GPT Image 2.5 Flare`). Do not hard-code the
model list or include prices or environment configuration unless asked.

Show the invocation for the user's host, and tell them how to call 幕芽:

| Host | Invocation and example |
| --- | --- |
| Codex desktop | Type `/` or `/skills` and select the Muvloom Skill if listed, or use `$muvloom 用这张商品照片制作一套电商图` |
| Codex CLI / IDE | `/skills` then Muvloom, or `$muvloom 生成一张小猫表情包` |
| Claude Code | Type `/muv` (the registered skill is `/muvloom`, which matches that prefix): `/muvloom 生成一张小猫表情包` |
| WorkBuddy | In a new task, type `/muv` and select `muvloom` / 幕芽 |
| 豆包工作 | In a new work task, type `/muv`, or type `/` or `@` and search for muv, 幕芽 or muvloom |
| Other hosts | Type `/muv` (or the host's equivalent slash) to find 幕芽; `用幕芽生成一张小猫表情包` also works |

Explain that the user can name any available model by id or label, or omit it
to use the displayed default. Natural-language requests using 幕芽, muya or
muvloom also work in supported hosts. If the installed Skill is not visible
yet, refresh the host's skill list or ask the user to fully quit and reopen
the client, then retry `/muv`; do not invent an unregistered slash alias.
These are chat prompts, not terminal commands: use `muvloom` as the executable
name for every CLI command.

`auth status` shows `credential_store: file` by default: CLI 0.2.7+ stores
credentials in a `0600` `credentials.json` file inside the `0700` muvloom config
directory (`MUVLOOM_CONFIG_DIR` when set, otherwise `~/Library/Application Support/muvloom`
on macOS, `~/.config/muvloom` on Linux, `%APPDATA%\muvloom` on Windows) so silent
binary upgrades never trigger OS keychain prompts (`MUVLOOM_CREDENTIALS_STORE=keychain`
explicitly opts into the system keychain). On CLI 0.2.6 or earlier (or when keychain mode is
requested), `credential_store_issue: unavailable` or `unsupported_platform` means
the system keychain could not be used and the CLI fell back to `credentials.json`
— it is not a setup failure.

To sign out later, run `muvloom auth logout` (it revokes the server connection
when it can and deletes stored credentials; it does not uninstall the CLI). To
uninstall, delete the `muvloom` binary from the install directory the installer
printed, remove the PATH line it added (it printed the exact profile file), and
optionally delete that config directory after logout.

Follow the installed skill or CLI help for future requests. A user's generation
request authorizes generation: proceed directly without a credit quote or a
second confirmation. Quote costs only when asked, and pass `--max-credits` only
for an explicit user-supplied credit limit. Setup itself must not spend credits.
