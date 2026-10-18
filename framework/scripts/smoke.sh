#!/usr/bin/env bash
# End-to-end smoke test: drives the compiled jobduck binary the way a new user does,
# in a throwaway home and workspace with all three agent hosts faked as installed.
# Usage: bun run build && bash scripts/smoke.sh [path/to/jobduck]
set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) exe=.exe ;;
  *) exe= ;;
esac
binary=$(cd "$(dirname "${1:-dist/jobduck$exe}")" && pwd)/$(basename "${1:-dist/jobduck$exe}")
[[ -x "$binary" ]] || { echo "smoke: $binary is missing; run bun run build" >&2; exit 1; }

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT INT TERM
export HOME="$root/home" USERPROFILE="$root/home" JOBDUCK_HOME="$root/jobduck-home"
workspace="$root/workspace"
mkdir -p "$HOME/.codex" "$HOME/.gemini" "$workspace"
echo '{}' > "$HOME/.claude.json"
printf 'model = "o4-mini"\n' > "$HOME/.codex/config.toml"
echo '{"theme":"Default"}' > "$HOME/.gemini/settings.json"
export PATH="$(dirname "$binary"):$PATH"

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
show() { sed 's/^/     | /' "$1" >&2; return 1; }
contains() { grep -qF -- "$1" "$2" || show "$2"; }
lacks() { ! grep -qE -- "$1" "$2" || show "$2"; }
count() { [[ "$(grep -cE -- "$1" "$2")" == "$3" ]] || show "$2"; }

run() {
  local log=$1
  shift
  "$@" > "$log" 2>&1 || { echo "--- $* exited $?" >&2; cat "$log" >&2; return 1; }
}

version=$("$binary" --version)
check "--version prints a version" eval '[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]'
check "--help lists every command" bash -c "\"$binary\" --help | grep -q init && \"$binary\" --help | grep -q doctor && \"$binary\" --help | grep -q mcp"

run "$root/dry.log" "$binary" init --dry-run --workspace "$workspace"
check "init --dry-run exits 0" true
check "dry run detects all hosts" contains 'Hosts: Claude Code, Codex CLI, Gemini CLI' "$root/dry.log"
check "dry run groups skill pointers" contains 'create .claude/skills/jobduck-*/SKILL.md (6 skill pointers)' "$root/dry.log"
check "dry run shows codex config under ~" contains 'update ~/.codex/config.toml' "$root/dry.log"
check "dry run prints no unified diff" lacks '^[-+@]{2,3} ' "$root/dry.log"
check "dry run stays short" eval '[[ "$(wc -l < "$root/dry.log")" -le 20 ]]'
check "dry run writes nothing" eval '[[ ! -e "$JOBDUCK_HOME" && ! -e "$workspace/.mcp.json" ]]'

run "$root/diff.log" "$binary" init --dry-run --diff --workspace "$workspace"
check "init --diff prints unified diffs" contains '+++ ' "$root/diff.log"

run "$root/apply.log" "$binary" init --yes --workspace "$workspace"
check "init --yes exits 0" true
check "init reports completion" contains 'Done. Open your agent in this workspace' "$root/apply.log"
check "home has profile, permissions and db" eval '[[ -f "$JOBDUCK_HOME/profile.md" && -f "$JOBDUCK_HOME/permissions.toml" && -f "$JOBDUCK_HOME/jobduck.db" ]]'
check "six skills installed" eval '[[ "$(ls "$JOBDUCK_HOME/skills"/*.md | wc -l)" -eq 6 && -f "$JOBDUCK_HOME/skills/.version" ]]'
check "claude: .mcp.json registers jobduck" contains '"jobduck"' "$workspace/.mcp.json"
check "claude: AGENTS.md and CLAUDE.md pointer" bash -c "[[ -f '$workspace/AGENTS.md' ]] && grep -q '@AGENTS.md' '$workspace/CLAUDE.md'"
check "claude: six skill pointers" eval '[[ "$(ls "$workspace"/.claude/skills/jobduck-*/SKILL.md | wc -l)" -eq 6 ]]'
check "codex: config.toml registers jobduck" contains '[mcp_servers.jobduck]' "$HOME/.codex/config.toml"
check "codex: existing config preserved" contains 'model = "o4-mini"' "$HOME/.codex/config.toml"
check "codex: six skill pointers" eval '[[ "$(ls "$workspace"/.agents/skills/jobduck-*/SKILL.md | wc -l)" -eq 6 ]]'
check "gemini: settings.json registers jobduck" contains '"jobduck"' "$HOME/.gemini/settings.json"
check "gemini: existing settings preserved" contains '"theme"' "$HOME/.gemini/settings.json"
check "gemini: GEMINI.md pointer" contains 'See AGENTS.md' "$workspace/GEMINI.md"

run "$root/again.log" "$binary" init --yes --workspace "$workspace"
check "second init is a no-op" contains 'Nothing to do.' "$root/again.log"

run "$root/doctor.log" "$binary" doctor --workspace "$workspace"
check "doctor exits 0" true
check "doctor has no FAIL line" lacks '^FAIL' "$root/doctor.log"
check "doctor sees three registered hosts" count 'host .*: registered' "$root/doctor.log" 3
run "$root/doctor.json" "$binary" doctor --json --workspace "$workspace"
check "doctor --json reports ok" contains '"ok": true' "$root/doctor.json"

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | "$binary" mcp > "$root/mcp.out" 2> "$root/mcp.err" || { echo "--- jobduck mcp exited $?" >&2; cat "$root/mcp.err" >&2; failures=$((failures + 1)); }
check "mcp answers with exactly two JSON-RPC lines" eval '[[ "$(grep -c . "$root/mcp.out")" -eq 2 ]]'
check "mcp initialize names the server" contains '"name":"jobduck"' "$root/mcp.out"
check "mcp tools/list includes search_jobs" contains '"search_jobs"' "$root/mcp.out"
check "mcp stdout is JSON only" bash -c "! grep -vE '^\{' '$root/mcp.out' | grep -q ."

"$binary" dashboard --port 0 --print-url --no-open > "$root/dashboard.url" 2> "$root/dashboard.err" &
dashboard_pid=$!
url=
for _ in $(seq 1 50); do
  url=$(grep -m1 -E '^http://127\.0\.0\.1:[0-9]+' "$root/dashboard.url" || true)
  [[ -n "$url" ]] && break
  sleep 0.2
done
check "dashboard prints a loopback URL" eval '[[ -n "$url" ]]'
if [[ -n "$url" ]]; then
  check "dashboard serves the page" bash -c "curl -fsS -o /dev/null -w '%{http_code}' '$url/' | grep -q '^200$'"
  check "dashboard API answers" bash -c "curl -fsS '$url/api/summary' | grep -q '{'"
fi
kill "$dashboard_pid" 2>/dev/null || true
wait "$dashboard_pid" 2>/dev/null || true

if (( failures > 0 )); then
  echo "smoke: $failures check(s) failed" >&2
  exit 1
fi
echo "smoke: all checks passed ($version)"
