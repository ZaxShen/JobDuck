#!/usr/bin/env bash
# Local check of the dev loop: starts bun scripts/dev.ts in a throwaway home on spare ports and
# drives the dashboard through the Vite proxy, including the cross-origin refusal.
# Usage: bash scripts/dev-smoke.sh
set -euo pipefail

cd "$(dirname "$0")/.."

api=${JOBDUCK_DEV_API_PORT:-4859}
web=${JOBDUCK_DEV_WEB_PORT:-5174}
root=$(mktemp -d)
log="$root/dev.log"
export JOBDUCK_HOME="$root/home" JOBDUCK_DEV_API_PORT=$api JOBDUCK_DEV_WEB_PORT=$web

descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    echo "$child"
    descendants "$child"
  done
}

dev_pid=
cleanup() {
  if [[ -n $dev_pid ]]; then
    local tree
    tree=$(descendants "$dev_pid")
    kill -TERM "$dev_pid" 2>/dev/null || true
    wait "$dev_pid" 2>/dev/null || true
    [[ -z $tree ]] || kill -TERM $tree 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT INT TERM

bun scripts/dev.ts >"$log" 2>&1 &
dev_pid=$!

base="http://127.0.0.1:$web"
deadline=$((SECONDS + 60))
until curl -sf -o /dev/null "$base/" && curl -sf -o /dev/null "$base/api/summary"; do
  if ! kill -0 "$dev_pid" 2>/dev/null || ((SECONDS >= deadline)); then
    echo "dev-smoke: dev loop did not come up on $base" >&2
    sed 's/^/     | /' "$log" >&2
    exit 1
  fi
  sleep 0.5
done

failures=0
check() {
  local name=$1
  shift
  if "$@"; then
    echo "ok   $name"
  else
    echo "FAIL $name" >&2
    failures=$((failures + 1))
  fi
}

out="$root/out"
status() { curl -s -o "$out" -w '%{http_code}' "$@"; }
expect() {
  local want=$1
  shift
  local got
  got=$(status "$@")
  [[ $got == "$want" ]] || { echo "     | expected $want, got $got: $(cat "$out")" >&2; return 1; }
}
body_has() { grep -qF -- "$1" "$out" || { echo "     | missing $1 in: $(cat "$out")" >&2; return 1; }; }

page() { expect 200 "$base/" && body_has 'id="root"'; }
listing() { expect 200 "$base/api/applications" && body_has 'Acme'; }
check 'GET / through Vite serves the app' page
check 'GET /api/applications through Vite returns seeded data' listing

id=$(grep -oE '[{,]"id":[0-9]+' "$out" | head -1 | grep -oE '[0-9]+' || true)
patch() {
  [[ -n $id ]] || { echo '     | no application id in the listing' >&2; return 1; }
  expect "$1" -X PATCH "$base/api/applications/$id" -H "Origin: $2" -H 'X-JobDuck-Dashboard: 1' \
    -H 'Content-Type: application/json' --data '{"note":"dev-smoke note"}'
}
check 'PATCH from the dev origin is saved' patch 200 "$base"
check 'PATCH from a foreign origin is refused' patch 403 'https://evil.example'
check 'the sandbox home has jobduck.db' test -f "$JOBDUCK_HOME/jobduck.db"

if ((failures > 0)); then
  echo "dev-smoke: $failures check(s) failed" >&2
  sed 's/^/     | /' "$log" >&2
  exit 1
fi
echo 'dev-smoke: all checks passed'
