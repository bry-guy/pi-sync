#!/usr/bin/env bash
# Pin $DIGEST (built from $SHA) in deploy/k8s/deployment.yaml, push to main, and
# wait until production serves $SHA. Argo CD syncs deploy/k8s from main.
# Usage: SHA=<commit> DIGEST=sha256:<hex> scripts/deploy.sh production
set -euo pipefail

[[ "${1:-}" == production ]] || { echo "usage: deploy.sh production" >&2; exit 2; }
[[ "${DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "DIGEST must be sha256:<64 hex>" >&2; exit 2; }
[[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "SHA must be a 40-character commit SHA" >&2; exit 2; }

file=deploy/k8s/deployment.yaml
url=https://pi-sync.bry-guy.net/v1/health

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3 4 5; do
  git fetch --quiet origin main
  git reset --quiet --hard origin/main
  # A newer source commit on main deploys itself; deploying this older one would roll production back.
  if [ -n "$(git log --format=%H "$SHA..HEAD" -- . ':!deploy/k8s')" ]; then
    echo "$SHA is superseded on main; skipping production deploy"
    exit 0
  fi
  sed -i -E "s|ghcr\.io/bry-guy/pi-syncd@sha256:[0-9a-f]{64}|ghcr.io/bry-guy/pi-syncd@$DIGEST|" "$file"
  [ "$(grep -c "pi-syncd@$DIGEST" "$file")" = 1 ] || { echo "expected one pi-syncd image reference in $file" >&2; exit 1; }
  if git diff --quiet; then
    echo "production already pins $DIGEST"
    break
  fi
  git commit --quiet -m "deploy(production): ${SHA:0:7}" -m "Source: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/commit/$SHA" -- "$file"
  if git push --quiet origin HEAD:main; then
    echo "Pushed production pin for ${SHA:0:7}"
    break
  fi
  [ "$attempt" -lt 5 ] || { echo "could not push the production pin" >&2; exit 1; }
  sleep $((attempt * 3))
done

# Argo CD polls Git every few minutes; allow for pickup plus rollout.
for _ in $(seq 1 60); do
  build="$(curl --fail --silent --connect-timeout 5 --max-time 10 "$url" | jq -r '.buildId // empty' || true)"
  if [ "$build" = "$SHA" ]; then
    echo "production is serving ${SHA:0:7}"
    exit 0
  fi
  sleep 10
done
echo "production did not serve ${SHA:0:7} within 10 minutes (last: ${build:-unreachable}); check Argo CD" >&2
exit 1
