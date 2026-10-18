#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TARGETS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$@"; }
else
  echo "build-all: need sha256sum or shasum" >&2
  exit 1
fi

mkdir -p dist
assets=()
for target in "${TARGETS[@]}"; do
  name="jobduck-${target}"
  [[ "$target" == windows-* ]] && name="${name}.exe"
  bun build --compile --target="bun-${target}" src/cli.ts --outfile "dist/${name}"
  assets+=("$name")
done

(cd dist && sha "${assets[@]}") > dist/SHA256SUMS
cat dist/SHA256SUMS
