#!/usr/bin/env bash
# Decides whether a pushed tag may be released and prints key=value lines for $GITHUB_OUTPUT.
# vX.Y.Z-rc.N must be on dev and ships as a prerelease. vX.Y.Z must be on main, and an earlier
# vX.Y.Z-rc.N must differ from it only in the package.json version, so what testers ran is what ships.
set -euo pipefail

tag=${1:?usage: release-gate.sh <tag>}
dev_ref=${RELEASE_DEV_REF:-origin/dev}
main_ref=${RELEASE_MAIN_REF:-origin/main}

fail() {
  echo "release gate: $*" >&2
  exit 1
}

cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-list -n 1 "$tag" 2>/dev/null) || fail "no tag $tag"

if [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]]; then
  git merge-base --is-ancestor "$sha" "$dev_ref" || fail "$tag is not on $dev_ref; tag release candidates on dev"
  echo "channel=rc"
elif [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  git merge-base --is-ancestor "$sha" "$main_ref" || fail "$tag is not on $main_ref; tag stable releases on main"
  rc=$(git tag -l "$tag-rc.*" --sort=-v:refname | head -n 1)
  [ -n "$rc" ] || fail "no $tag-rc.N tag; publish $tag-rc.1 from dev and test it first"
  others=$(git diff --name-only "$rc" "$sha" -- . ':!framework/package.json')
  [ -z "$others" ] || fail "$tag changes files since $rc: $(echo "$others" | tr '\n' ' ')- cut a new release candidate"
  edits=$(git diff -U0 "$rc" "$sha" -- framework/package.json | grep -E '^[-+]([^-+]|$)' | grep -vE '^[-+][[:space:]]*"version": ' || true)
  [ -z "$edits" ] || fail "$tag changes framework/package.json beyond the version since $rc - cut a new release candidate"
  previous=$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | awk -v tag="$tag" 'found { print; exit } $0 == tag { found = 1 }')
  echo "channel=stable"
  echo "rc=$rc"
  echo "previous=$previous"
else
  fail "$tag is neither vX.Y.Z nor vX.Y.Z-rc.N"
fi
