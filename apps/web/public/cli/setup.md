# Muvloom agent setup

Install Muvloom CLI, connect the user's account, and report when it is ready.
Detect the operating system and use the agent host named in the user's request.
Keep the conversation in the user's language. Run the steps yourself, including
opening the authorization page; the user signs in and approves the connection.
Do not generate images during setup.

## 1. Install CLI 0.1.0

Use the matching platform below. The scripts are pinned to the released source
commit and verify the downloaded binary's SHA-256. If installation fails, report
the error; do not bypass verification.

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/Muluk-m/ai-image-playground/0ac3c6410211e2a8532022b42a3c45cc10c1f5cc/cli-go/install/install.sh | MUVLOOM_VERSION=0.1.0 sh
export PATH="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
```

### Windows (PowerShell)

```powershell
$env:MUVLOOM_VERSION = "0.1.0"; irm https://raw.githubusercontent.com/Muluk-m/ai-image-playground/0ac3c6410211e2a8532022b42a3c45cc10c1f5cc/cli-go/install/install.ps1 | iex
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

Set `MUVLOOM_API_URL` for every Muvloom command, including subsequent sessions.
Use `export MUVLOOM_API_URL="<matching URL>"` on macOS / Linux, or
`$env:MUVLOOM_API_URL = "<matching URL>"` in PowerShell. If the origin is not
listed, ask which service to connect to instead of silently using production.

## 3. Install host instructions when supported

For Claude Code, run:

```sh
muvloom skill install --host claude-code
```

For Codex, run:

```sh
muvloom skill install --host codex
```

For WorkBuddy, 豆包工作, and other hosts, skip this step. CLI 0.1.0 only
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

## 5. Confirm readiness

Run `muvloom capabilities` to discover the available models. Only report the
connection as ready after auth status confirms it and capabilities succeeds.
Tell the user they can now ask you to generate images. Follow the installed
skill or CLI help for future requests. A user's generation request authorizes
generation: proceed directly without a credit quote or a second confirmation.
Quote costs only when asked, and pass `--max-credits` only for an explicit
user-supplied credit limit. This also applies to the Skill bundled in CLI 0.1.0,
whose older instructions require a quote and budget approval.
Setup itself must not spend credits.
