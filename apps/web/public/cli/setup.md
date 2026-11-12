# Muvloom agent setup

Install Muvloom CLI, connect the user's account, install the official skill when
the host can use one, and report when it is ready. Detect the operating system
and use the agent host named in the user's request. Keep the conversation in the
user's language. Do not generate images during setup, and do not spend credits
unless the user asks.

When this guide points to another file in the same folder (for example
`workbuddy.md`, `doubao.md`, `install.sh`, `install.ps1`, or a skill zip), fetch
it from the same address as this page with its file name replaced, keeping this
page's `?v=` query. That value changes whenever the guides or installers change,
so a cached older copy is never used.

## 1. Install CLI 0.2.4 or newer

Run `muvloom version` first, and also look for a copy that is installed but
missing from PATH (`~/.local/bin/muvloom`, `/usr/local/bin/muvloom`,
`/opt/homebrew/bin/muvloom` on macOS / Linux; `%LOCALAPPDATA%\Programs\muvloom\muvloom.exe`
on Windows).

- If the installed version is already 0.2.4 or newer, do not run the installer.
  An exact-version pin can downgrade a newer CLI; the installer also refuses to
  downgrade, but you must not paste an install command over a newer copy.
- If the command is missing, or the version is lower than 0.2.4, install with
  the commands below. The installer replaces the existing CLI in place, keeps
  the user's sign-in, and will not install a release older than
  `MUVLOOM_MIN_VERSION`. It installs the latest release that meets that minimum,
  not an exact pin.

Do not pipe a downloaded script into `sh` or `iex`. Download it to a temporary
file, verify the SHA-256 published here, then execute. Fetch `install.sh` or
`install.ps1` from the same folder as this guide (same origin and `?v=`).

### macOS / Linux

SHA-256 of `install.sh`:
`ca475b8aaa141716604c94444675cefb787f7e49bc750aa510101421943da6b9`

```sh
tmp="$(mktemp)"
curl -fsSL "<this-guide-origin>/cli/install.sh?v=<this-page-v>" -o "$tmp"
actual="$(command -v sha256sum >/dev/null && sha256sum "$tmp" | awk '{print $1}' || shasum -a 256 "$tmp" | awk '{print $1}')"
[ "$actual" = "ca475b8aaa141716604c94444675cefb787f7e49bc750aa510101421943da6b9" ] || { echo "checksum mismatch"; exit 1; }
MUVLOOM_MIN_VERSION=0.2.4 sh "$tmp"
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
`9f0d1b1c15dcbd0704cc6cdd2dd88e3a5f8cc76d7bc43161e6ccf97bea3ba606`

```powershell
$script = Join-Path $env:TEMP "muvloom-install.ps1"
Invoke-WebRequest "<this-guide-origin>/cli/install.ps1?v=<this-page-v>" -OutFile $script
if ((Get-FileHash $script -Algorithm SHA256).Hash.ToLower() -ne "9f0d1b1c15dcbd0704cc6cdd2dd88e3a5f8cc76d7bc43161e6ccf97bea3ba606") { throw "checksum mismatch" }
$env:MUVLOOM_MIN_VERSION = "0.2.4"; powershell -NoProfile -ExecutionPolicy Bypass -File $script
$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")
```

The PATH update must also apply to subsequent commands in this agent session. If
installation fails, report the error; do not bypass verification or skip the
checksum.

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

For WorkBuddy, follow [the WorkBuddy guide](workbuddy.md) to install the official
skill from the conversation and connect the account. Confirm that a new task's
`/muv` finds 幕芽 before reporting setup complete.

For 豆包工作, follow [the Doubao Work guide](doubao.md) to install the official
skill from the conversation and connect the account. Confirm that a new work
task's `/muv` (or a `/` / `@` search for muv, 幕芽 or muvloom) finds 幕芽 before
reporting setup complete. Do not write into unverified directories such as
`~/.doubao/skills`.

For other hosts, download the official skill package `muvloom-skill.zip` from
the same folder as this guide (keep this page's `?v=`). If the host has a skill
directory, install the package's `muvloom/` directory there (target
`.../skills/muvloom/SKILL.md`, with no extra nested folder). If the host installs
skills through its UI, upload that zip or the `muvloom/` folder with the host's
add/upload-skill action. After setup, tell the user to type `/muv` (or the
host's equivalent slash) to find 幕芽.

CLI 0.2.4's `skill install --host` only accepts `claude-code` and `codex`. Do
not invent `--host workbuddy` or `--host doubao`, and do not write into an
unverified host configuration directory as the default method. A later CLI
release may add `muvloom skill install --host generic` as an escape hatch that
writes a local `muvloom/` directory (or `--output`) for you to upload; until
that release is installed, use the official zip above.

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
2. Run `muvloom auth login` in the foreground and let the CLI open the default
   browser itself. It returns `state: ready` as soon as the user approves.
3. `AUTH_PENDING`, or a command the host cut off, means the user has not
   approved yet: run `muvloom auth login` again. It resumes the same login and
   does not open another page. Stop on `AUTH_DENIED`; start over only on
   `AUTH_EXPIRED`.
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

`auth status` may show `credential_store: file` together with
`credential_store_issue: unavailable`. That means the system keychain could not
be used in this environment, so the CLI stored the login in a file in its
config directory instead. It is not a setup failure. The file store lives at
`credentials.json` in `MUVLOOM_CONFIG_DIR` when that is set, otherwise in the
user config directory (`~/Library/Application Support/muvloom` on macOS,
`~/.config/muvloom` on Linux, `%APPDATA%\muvloom` on Windows).
`unsupported_platform` means this OS has no keychain backend.

To sign out later, run `muvloom auth logout` (it revokes the server connection
when it can and deletes stored credentials; it does not uninstall the CLI). To
uninstall, delete the `muvloom` binary from the install directory the installer
printed, remove the PATH line it added (it printed the exact profile file), and
optionally delete that config directory after logout.

Follow the installed skill or CLI help for future requests. A user's generation
request authorizes generation: proceed directly without a credit quote or a
second confirmation. Quote costs only when asked, and pass `--max-credits` only
for an explicit user-supplied credit limit. Setup itself must not spend credits.
