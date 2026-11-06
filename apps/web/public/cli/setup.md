# Muvloom agent setup

Install Muvloom CLI, connect the user's account, and report when it is ready.
Detect the operating system and use the agent host named in the user's request.
Keep the conversation in the user's language. Run the steps yourself, including
opening the authorization page; the user signs in and approves the connection.
Do not generate images during setup.

## 1. Install CLI 0.1.3

Use the matching platform below. The scripts are pinned to the released source
commit and verify the downloaded binary's SHA-256. If installation fails, report
the error; do not bypass verification.

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/Muluk-m/ai-image-playground/ac156ba55e3f6238120a5b7629ff4d61c03f81ff/cli-go/install/install.sh | MUVLOOM_VERSION=0.1.3 sh
export PATH="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
```

### Windows (PowerShell)

```powershell
$env:MUVLOOM_VERSION = "0.1.3"; irm https://raw.githubusercontent.com/Muluk-m/ai-image-playground/ac156ba55e3f6238120a5b7629ff4d61c03f81ff/cli-go/install/install.ps1 | iex
$env:Path = [Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")
```

The PATH update must also apply to subsequent commands in this agent session.

## 2. Select the service

Use the origin of the setup URL supplied by the user:

| Setup origin | MUVLOOM_API_URL |
| --- | --- |
| https://muvloom.online | https://api.muvloom.online |
| https://image.nainma.online | https://api.muvloom.online |
| https://image-playground.qiliangjia.one | https://image-api.qiliangjia.one |
| https://test.muvloom.online | https://test-api.muvloom.online |

The CLI defaults to `https://api.muvloom.online`. For that service, use the default;
clear any conflicting `MUVLOOM_API_URL` override in the current agent session.
Only for a non-default service, set `MUVLOOM_API_URL` for subsequent commands in
the session: `export MUVLOOM_API_URL="<matching URL>"` on macOS / Linux, or
`$env:MUVLOOM_API_URL = "<matching URL>"` in PowerShell. Manage this internally;
the user does not need to configure or remember environment variables. If the
origin is not listed, ask which service to connect to instead of guessing.

## 3. Install host instructions when supported

For Claude Code, run:

```sh
muvloom skill install --host claude-code
```

For Codex, run:

```sh
muvloom skill install --host codex
```

For WorkBuddy, follow [the WorkBuddy guide](workbuddy.md) to import the official
skill ZIP and connect the account. Confirm that the skill appears in WorkBuddy
before reporting setup complete.

For 豆包工作 and other hosts, skip this step. CLI 0.1.3 only
accepts `claude-code` and `codex` as skill hosts. Use `muvloom --help` and
subcommand help to learn the CLI; do not invent a `--host` value or write into
an unverified host configuration directory.

## 4. Connect the account

Run `muvloom auth status` first. If its `data.state` is `ready`, keep the existing
connection and proceed to step 5. Otherwise:

1. Run `muvloom auth login --no-wait`.
2. Open the returned `verification_uri_complete` in the user's browser yourself,
   using the host's browser-opening tool. For a local desktop agent, an OS URL
   opener is also suitable (`open` on macOS, `Start-Process` in PowerShell, or
   `xdg-open` on Linux). Over SSH or in a remote environment, use a browser tool
   on the user's computer rather than opening a browser on the remote machine.
   Once the page is open, ask the user to sign in and approve the connection.
   Only if no suitable tool is available or opening fails, explain that limitation
   and provide `verification_uri_complete` and `user_code` for manual opening.
3. Run `muvloom auth login` to wait for approval and finish the pending login.
4. Run `muvloom auth status` and confirm `data.state` is `ready`.

If the user declines, stop. If the code expires, start a new login. Do not ask
for passwords, browser cookies, or tokens, and do not print stored credentials.

If the host interrupts login for a permission approval or replays the command, run
`muvloom auth status` before starting another login. A `ready` state means the
connection succeeded. Do not describe an invalid or already-used code as expired,
or repeatedly open new authorization pages after the user has approved. Never
disable the host's file or credential protection.

## 5. Confirm readiness

Run `muvloom capabilities` to verify that generation is available. Only report
the connection as ready after auth status confirms it and capabilities succeeds.
Briefly list this account's available model labels from that response and mark
`default_model`; use IDs if labels are missing or ambiguous. Do not hard-code the
model list or include prices or environment configuration unless asked.

Show the invocation for the user's host:

| Host | Invocation and example |
| --- | --- |
| Codex desktop | Type `/` and select the Muvloom Skill if listed, or use `$muvloom 用这张商品照片制作一套电商图` |
| Codex CLI / IDE | `/skills` → Muvloom, or `$muvloom 生成一张小猫表情包` |
| Claude Code | `/muvloom 生成一张小猫表情包` |
| Other hosts | `用幕芽生成一张小猫表情包` |

Explain that the user can name any available model in the request, or omit it to
use the displayed default. Natural-language requests using 幕芽, muya or muvloom
also work in supported hosts. If the installed Skill is not visible yet, refresh
the host's skill list or reopen the session; do not invent an unregistered slash
alias. These are chat prompts, not terminal commands: use `muvloom` as the
executable name for every CLI command.

Follow the installed skill or CLI help for future requests. A user's generation request authorizes
generation: proceed directly without a credit quote or a second confirmation.
Quote costs only when asked, and pass `--max-credits` only for an explicit
user-supplied credit limit. Setup itself must not spend credits.
