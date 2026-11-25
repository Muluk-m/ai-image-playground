#!/bin/sh
# Render one deployment's configuration from the config center (ADR 0035) into
#   ~/.config/ai-image-playground/rendered/<project>/
# with the release image itself, so the catalog always matches the code being deployed.
# Secrets come from the Config Worker using the Access service token in bootstrap.env; nothing is
# printed. The directory is replaced atomically; on any problem the previous one stays untouched.
#
#   scripts/config-render.sh <prod|test> <compose project> <image>
#
# A deployment switches to rendered configuration when deploy/deployments/<name>.json sets
# `"configSource": "rendered"`; scripts/vps-deploy.sh calls this on every release of such a
# deployment. Set `"configSource": "legacy"` to fall back to app.env.
set -eu
deployment=${1:-}
project=${2:-}
image=${3:-}
case "$deployment" in prod|test) ;; *) echo "Usage: $0 prod|test <project> <image>" >&2; exit 2 ;; esac
[ -n "$project" ] && [ -n "$image" ] || { echo "Usage: $0 prod|test <project> <image>" >&2; exit 2; }
ops_root=${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground
bootstrap=${CONFIG_BOOTSTRAP_FILE:-$ops_root/bootstrap.env}
rendered_root=$ops_root/rendered
[ -f "$bootstrap" ] || { echo "Config center bootstrap file not found: $bootstrap" >&2; exit 1; }
mkdir -p "$rendered_root"
chmod 700 "$rendered_root"
# The image's own CLI and descriptors (apps/bff/src/deploy-config-cli.ts, deploy/deployments).
# Run as the deploying user so the files stay readable by it and by nobody else.
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --mount "type=bind,source=$bootstrap,target=/run/config-bootstrap.env,readonly" \
  --mount "type=bind,source=$rendered_root,target=/rendered" \
  --workdir /app/apps/bff --entrypoint bun "$image" \
  run src/deploy-config-cli.ts render "$deployment" --out "/rendered/$project" \
  --bootstrap /run/config-bootstrap.env
