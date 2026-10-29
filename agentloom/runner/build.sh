#!/bin/bash
# The local runner for AgentLoom for customers. Runs on agentloom-build-01 every
# minute (agentloom-build.timer): when the agentloom branch has a commit not yet
# built, build the app image with a warm cache, push it to the registry on the
# app host, then ask Coolify to deploy, which only pulls and restarts.
#
# Only this one branch is ever built - never a pull request - so no stranger's
# code runs here. /etc/agentloom-build/env may hold COOLIFY_URL, COOLIFY_APP and
# a deploy-only COOLIFY_DEPLOY_TOKEN; without them it builds and pushes only.
set -euo pipefail

REPO=${AGENTLOOM_REPO:-https://github.com/darkcompute-io/rakazo.git}
BRANCH=${AGENTLOOM_BRANCH:-agentloom}
REGISTRY=${AGENTLOOM_REGISTRY:-10.56.10.48:5000}
WORK=/srv/agentloom
SRC=$WORK/src
STATE=$WORK/built
IMAGE=$REGISTRY/agentloom-app

mkdir -p "$WORK"
exec 9>"$WORK/.lock"
flock -n 9 || exit 0

[ -d "$SRC/.git" ] || git clone -q --branch "$BRANCH" "$REPO" "$SRC"
git -C "$SRC" fetch -q origin "$BRANCH"
SHA=$(git -C "$SRC" rev-parse "origin/$BRANCH")
[ "$(cat "$STATE" 2>/dev/null)" = "$SHA" ] && exit 0

git -C "$SRC" checkout -q --force --detach "$SHA"
start=$(date +%s)
echo "building ${SHA:0:9}: $(git -C "$SRC" log -1 --format=%s "$SHA")"

# Upstream's image, unchanged, then our layer on top (agentloom/Dockerfile).
docker build --quiet -f "$SRC/infra/compose/Dockerfile" --build-arg "GIT_SHA=$SHA" \
  -t agentloom-app-base:build "$SRC" >/dev/null
docker build --quiet --build-context base=docker-image://agentloom-app-base:build \
  -t "$IMAGE:$SHA" -t "$IMAGE:$BRANCH" "$SRC/agentloom" >/dev/null
docker push --quiet "$IMAGE:$SHA" >/dev/null
docker push --quiet "$IMAGE:$BRANCH" >/dev/null
echo "$SHA" >"$STATE"
echo "pushed $IMAGE:${SHA:0:9} in $(($(date +%s) - start))s"

if [ -r /etc/agentloom-build/env ]; then
  # Read as data, never sourced: a Coolify token holds a "|", which a shell would run.
  while IFS='=' read -r key value; do
    case "$key" in COOLIFY_URL | COOLIFY_APP | COOLIFY_DEPLOY_TOKEN) printf -v "$key" '%s' "$value" ;; esac
  done </etc/agentloom-build/env
  if [ -n "${COOLIFY_DEPLOY_TOKEN:-}" ] && [ -n "${COOLIFY_URL:-}" ] && [ -n "${COOLIFY_APP:-}" ]; then
    curl -fsS -m 30 -X POST -H "Authorization: Bearer $COOLIFY_DEPLOY_TOKEN" \
      "$COOLIFY_URL/api/v1/deploy?uuid=$COOLIFY_APP" >/dev/null && echo "deploy requested"
  fi
fi

# Keep the build cache warm but the disk bounded.
docker image prune -f --filter "until=72h" >/dev/null
docker builder prune -f --keep-storage 40gb >/dev/null 2>&1 || true
