#!/bin/sh
set -eu
# Deployment integration check on a real Docker host (CI's deploy-integration job; never on the
# laptop). Mocks cannot show how Compose merges the rendered overlay, who may read the files a
# connector mounts, or what a running bind mount sees after an update; this does, with fixture
# secrets and nothing started that talks to the network.
#
#   scripts/deploy-integration.sh
#
# 1. Renders the test deployment from its descriptor with fixture secrets (as config-render.sh would).
# 2. Resolves compose.app.yaml + compose.rendered.yaml through app-compose.sh and checks that every
#    service sees exactly its rendered values, the connector runs as the deploying user and binds
#    the tunnels directory, and pg-backup's interpolation placeholders never reach a container.
# 3. Stages the tunnel files the way a deploy does and has the pinned cloudflared image parse them as
#    the deploying user; its default user must not be able to (that is why the overlay sets one).
# 4. Shows that an in-place write reaches a running bind mount while a replaced directory does not,
#    which is what stage_tunnels relies on.

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project=image-playground-test
work=$(mktemp -d "${TMPDIR:-/tmp}/aip-deploy-integration.XXXXXX")
probe=
cleanup() {
  [ -z "$probe" ] || docker rm -f "$probe" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "deploy integration: $*" >&2; exit 1; }

XDG_CONFIG_HOME=$work/config
HOME=$work/home
export XDG_CONFIG_HOME HOME
mkdir -p "$HOME"
config=$XDG_CONFIG_HOME/ai-image-playground
rendered=$config/rendered/$project
tunnels=$config/tunnels/$project
cloudflared_image=$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(cloudflare\/cloudflared:[^[:space:]]*\).*/\1/p' "$repo/deploy/compose.app.yaml" | head -n 1)
[ -n "$cloudflared_image" ] || fail "no cloudflared image in compose.app.yaml"

echo '== render the test deployment with fixture secrets'
(cd "$repo" && bun run scripts/deploy-fixture-secrets.ts test) > "$work/test.secrets"
(cd "$repo" && bun run apps/bff/src/deploy-config-cli.ts render test --out "$rendered" --secrets-file "$work/test.secrets")

echo '== resolve the rendered compose configuration'
CONFIG_SOURCE=rendered sh "$repo/scripts/app-compose.sh" compose "$project" config --format json > "$work/compose.json"
python3 - "$work/compose.json" "$rendered" "$tunnels" "$(id -u):$(id -g)" <<'PY'
import json, os, sys
compose, rendered, tunnels, user = sys.argv[1:]
services = json.load(open(compose))["services"]
problems = []
def env_file(service):
    values = {}
    with open(os.path.join(rendered, "env", f"{service}.env")) as handle:
        for line in handle:
            line = line.rstrip("\n")
            if line:
                key, _, value = line.partition("=")
                values[key] = value
    return values
checked = 0
for name, service in services.items():
    path = os.path.join(rendered, "env", f"{name}.env")
    if not os.path.exists(path):
        continue
    checked += 1
    environment = service.get("environment") or {}
    for key, value in env_file(name).items():
        if environment.get(key) != value:
            problems.append(f"{name}: {key} does not reach the container as rendered")
    leaked = [key for key, value in environment.items() if value == "rendered"]
    if leaked:
        problems.append(f"{name}: interpolation placeholder reaches the container: {', '.join(sorted(leaked))}")
if checked < 5:
    problems.append(f"only {checked} services matched a rendered env file")
connector = services.get("cloudflared", {})
if connector.get("user") != user:
    problems.append(f"cloudflared runs as {connector.get('user')!r}, not the deploying user {user}")
sources = [volume.get("source") for volume in connector.get("volumes", [])]
if os.path.join(tunnels, "main") not in sources:
    problems.append(f"cloudflared binds {sources}, not {tunnels}/main")
if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
print(f"{checked} services see exactly their rendered values; cloudflared runs as {user} from {tunnels}/main")
PY

echo '== stage the tunnel files and let cloudflared read them'
[ -f "$tunnels/main/config.yml" ] && [ -f "$tunnels/main/credentials.json" ] ||
  fail "app-compose.sh did not stage $tunnels/main"
for file in config.yml credentials.json; do
  mode=$(stat -c %a "$tunnels/main/$file")
  [ "$mode" = 600 ] || fail "$tunnels/main/$file is $mode, not 600"
done
docker run --rm --user "$(id -u):$(id -g)" -v "$tunnels/main:/etc/cloudflared:ro" "$cloudflared_image" \
  tunnel --config /etc/cloudflared/config.yml ingress validate ||
  fail "cloudflared cannot read the staged tunnel files as the deploying user"
if docker run --rm -v "$tunnels/main:/etc/cloudflared:ro" "$cloudflared_image" \
  tunnel --config /etc/cloudflared/config.yml ingress validate >/dev/null 2>&1; then
  fail "cloudflared's default user reads 0600 files it does not own; the user override is no longer what protects them"
fi

echo '== a running bind mount follows in-place writes, not replaced directories'
mkdir -p "$work/mount"
printf 'one\n' > "$work/mount/file"
probe=aip-deploy-integration-$$
docker run -d --name "$probe" --user "$(id -u):$(id -g)" -v "$work/mount:/probe:ro" busybox:1.37 sleep 120 >/dev/null
printf 'two\n' > "$work/mount/file"
[ "$(docker exec "$probe" cat /probe/file)" = two ] || fail "an in-place write did not reach the running container"
mv "$work/mount" "$work/mount.old"
mkdir "$work/mount"
printf 'three\n' > "$work/mount/file"
[ "$(docker exec "$probe" cat /probe/file)" = two ] ||
  fail "a replaced directory reached the running container; stage_tunnels' in-place update is no longer needed"

echo 'deploy integration passed'
