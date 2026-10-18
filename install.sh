#!/bin/sh
# Install the jobduck binary from GitHub Releases into a user directory (no root needed).
# Usage: curl -fsSL https://raw.githubusercontent.com/ZaxShen/JobDuck/main/install.sh | sh
# Env: JOBDUCK_VERSION (default: latest release), JOBDUCK_INSTALL_DIR (default: $HOME/.local/bin)
set -eu

REPO=ZaxShen/JobDuck

fail() {
  echo "jobduck install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); on Windows download jobduck-windows-x64.exe from https://github.com/$REPO/releases" ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported CPU $(uname -m); builds exist for arm64 and x64" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"

asset="jobduck-$os-$arch"
version=${JOBDUCK_VERSION:-}
version=${version#v}
if [ -n "$version" ]; then
  base="https://github.com/$REPO/releases/download/v$version"
else
  base="https://github.com/$REPO/releases/latest/download"
fi
dir=${JOBDUCK_INSTALL_DIR:-"$HOME/.local/bin"}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ${version:-(latest)}"
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no line for $asset"

if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  fail "need shasum or sha256sum to verify the download"
fi

[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual); not installing"

mkdir -p "$dir"
chmod 755 "$tmp/$asset"
mv -f "$tmp/$asset" "$dir/jobduck"

echo "Installed $("$dir/jobduck" --version) to $dir/jobduck"

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    echo
    echo "$dir is not on your PATH. Add it to your shell profile:"
    echo "  export PATH=\"$dir:\$PATH\""
    ;;
esac

echo
echo "Next: mkdir ~/JobDuck && cd ~/JobDuck && jobduck init"
