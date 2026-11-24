# shellcheck shell=sh
# Which repository paths each production side is built from. ci-deploy-target.sh ships a side only
# when one of its paths changed; release-status.sh lists only the commits that touch a side. A
# pnpm-lock.yaml edit counts for every side here; ci-deploy-target.sh narrows it further with
# scripts/lock-closure-changed.mjs.
# The shared muvloom Pages project reads the web list; Admin reads its own; the API reads the last.
# admin.muvloom.online is the Pages build of apps/admin; the API image only serves admin-api.
# shellcheck disable=SC2034 # used by the scripts that source this file
RELEASE_WEB_PATHS='^(apps/web/|apps/website/|cli-go/|scripts/build-cli-web-bins\.sh$|packages/shared/|pnpm-workspace\.yaml$)'
# shellcheck disable=SC2034
RELEASE_ADMIN_PATHS='^(apps/admin/|packages/read-models/|packages/shared/|pnpm-workspace\.yaml$)'
# Build and deployment protocol changes require a new release. Deployment code itself lives in the
# fixed VPS runtime and must be installed separately from the data-only release.
# shellcheck disable=SC2034
RELEASE_API_PATHS='^(apps/bff/|apps/admin/|packages/|Dockerfile$|deploy/|pnpm-workspace\.yaml$|scripts/build-vps-release\.sh$|scripts/docker-entrypoint\.sh$|scripts/vps-deploy\.sh$|scripts/app-compose\.sh$|scripts/rollout-runtime\.sh$|scripts/check-test-isolation\.sh$|scripts/segmenter-deploy\.sh$|scripts/lib/deploy-common\.sh$)'
